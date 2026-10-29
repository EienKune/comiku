"""Local immutable PixAI backbones, official processor, pre-tag pooled features.

Reusable API: encoder=load_encoder('FP32' or 'INT8'); encoder.encode_paths(paths).
Return raw1024 features, native blue_archive probabilities, top10 tag evidence.
Use L2-normalized raw features with the separately frozen three-class head.
No label reads, downloads, product writes or weight changes.
"""
from pathlib import Path
import gc,hashlib,importlib.util,os,sys
from unittest.mock import patch
import numpy as np
import torch
from PIL import Image,ImageOps

ROOT=Path(__file__).resolve().parents[2]
MODEL=ROOT/'experiments/20261012-pixai-v1/base-model'
CHECKPOINT=ROOT/'experiments/20261012-pixai-linear-int8-2215/pixai-linear-dynamic-int8-state.pt'
CHECKPOINT_SHA='bcb66dd898ee241e2172bfd4aa9e03c9df3f538df503c2404657980c02cc5c4b'
PIPELINE_SHA='3431279fdfff234f62664999fc1fe6bb20f1e8756f7435d0e165ebd4456f7fcd'
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def pipeline():
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    assert sha(MODEL/'tagger_pipeline.py')==PIPELINE_SHA
    name='pixai_local_feature_pipeline';spec=importlib.util.spec_from_file_location(name,MODEL/'tagger_pipeline.py')
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module
def restore_int8(module):
    assert sha(CHECKPOINT)==CHECKPOINT_SHA
    config=module.ViTDetClsConfig.from_pretrained(str(MODEL),local_files_only=True)
    original_linspace=torch.linspace
    def control_linspace(*a,**kw):kw.setdefault('device','cpu');return original_linspace(*a,**kw)
    with patch.object(torch,'linspace',control_linspace),torch.device('meta'):model=module.ViTDetCls(config)
    linear=[(n,m.in_features,m.out_features,m.bias is not None) for n,m in model.named_modules() if isinstance(m,torch.nn.Linear)]
    for name,inf,outf,bias in linear:
        parent_name,_,leaf=name.rpartition('.');parent=model.get_submodule(parent_name) if parent_name else model
        setattr(parent,leaf,torch.ao.nn.quantized.dynamic.Linear(inf,outf,bias_=bias,dtype=torch.qint8))
    assert len(linear)==131;model.to_empty(device='cpu')
    state=torch.load(CHECKPOINT,map_location='cpu',weights_only=False)
    model.load_state_dict(state,strict=True,assign=True);del state
    for layer in model.modules():
        if isinstance(layer,module.Attention) and layer.use_rope:layer._setup_rope_freqs()
    model.eval().requires_grad_(False);gc.collect();return model
class PixAIEncoder:
    def __init__(self,model,module,device):
        self.model=model;self.device=device;self.processor=module.RescalePadProcessor(size=1008)
        self.tags=model.config.tags;self.ba_index=self.tags.index('blue_archive');self.feature_dim=model.config.embed_dim
        assert self.feature_dim==1024 and not any(p.requires_grad for p in model.parameters())
        self.captured=None;self.hook=model.head.register_forward_pre_hook(self._capture)
    def _capture(self,module,args):self.captured=args[0].detach()
    def preprocess_paths(self,paths):
        images=[]
        try:
            for path in paths:
                with Image.open(path) as image:images.append(ImageOps.exif_transpose(image).copy())
            return self.processor(images,return_tensors='pt')['pixel_values'].to(device=self.device,dtype=torch.float32)
        finally:
            for image in images:image.close()
    def forward(self,tensor,check_parity=False):
        with torch.inference_mode():
            self.captured=None;logits=self.model(tensor)
            assert self.captured is not None and self.captured.shape==(tensor.shape[0],1024)
            features=self.captured
            if check_parity:
                replay=self.model.head(features)
                assert torch.equal(replay,logits),'Pre-tag feature replay differs from native logits'
            scores=logits.float().sigmoid();topv,topi=scores.topk(10,dim=1)
            evidence=[[{'tag':self.tags[int(i)],'score':float(v)} for i,v in zip(ids,values)] for ids,values in zip(topi.cpu().tolist(),topv.cpu().tolist())]
            result={'features':features.float().cpu().numpy().copy(),'blue_archive':scores[:,self.ba_index].cpu().numpy().copy(),'top_evidence':evidence}
        if self.device=='cuda':torch.cuda.synchronize()
        assert np.isfinite(result['features']).all() and np.isfinite(result['blue_archive']).all()
        return result
    def encode_paths(self,paths,check_parity=False):return self.forward(self.preprocess_paths(paths),check_parity)
    def close(self):self.hook.remove()
def load_encoder(backbone):
    module=pipeline()
    if backbone=='FP32':
        assert torch.cuda.is_available()
        torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False;torch.set_float32_matmul_precision('highest')
        model=module.ViTDetCls.from_pretrained(str(MODEL),local_files_only=True,torch_dtype=torch.float32,low_cpu_mem_usage=True).to('cuda').eval().requires_grad_(False)
        assert {p.dtype for p in model.parameters()}=={torch.float32}
        return PixAIEncoder(model,module,'cuda')
    assert backbone=='INT8';return PixAIEncoder(restore_int8(module),module,'cpu')
