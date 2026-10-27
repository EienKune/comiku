The byte-identical `tagger_pipeline.py` and `preprocessor_config.json` come from
PixAI Labs' `pixai-labs/pixai-tagger-v1.0`, revision
`9fe10addf9326e292da8a85a98ea74cd91b41771`.

Upstream: https://huggingface.co/pixai-labs/pixai-tagger-v1.0

The upstream model card declares Apache-2.0. A copy is included in `LICENSE`.
The pipeline retains its original attribution comments to the ViTDet/SAM,
Code Llama, RoPE-ViT and rotary embedding sources. It has not been modified.

`frozen_feature_helper.py` is the project's own original immutable extraction
helper, copied here to retain its exact provenance and numerical behavior.
The parent `pixai_feature_helper.py` adapts local paths and loads the tracked
pipeline instead of reading code from an experiment directory. No pretrained
weights or tagger model config are included here.
