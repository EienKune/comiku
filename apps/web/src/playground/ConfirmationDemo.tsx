import { useState } from "react";
import { Button } from "../components/ui";
import { useConfirmation } from "../components/use-confirmation";
import { checkPunctuation } from "../features/editor/punctuation/check-punctuation";
import { SubmissionPunctuationWarnings } from "../features/editor/punctuation/SubmissionPunctuationWarnings";

const exampleTranslation = "老师,请等一下！";
const exampleWarnings = checkPunctuation(exampleTranslation).map((issue) => ({
  ...issue,
  imageNumber: 2,
  entryNumber: 1,
  text: exampleTranslation,
}));

export function ConfirmationDemo() {
  const [single, setSingle] = useState(false);
  const confirmation = useConfirmation([single]);
  async function changeMode() {
    if (
      await confirmation.confirm({
        title: single ? "开启多人协作？" : "切回单人模式？",
        description: single
          ? "同一阶段可加入多人，并启用页码分工与个人完成确认。"
          : "每个阶段至多保留一名参与者，且不能保留同一用户翻译并校对的记录。",
        confirmLabel: single ? "开启多人协作" : "切回单人模式",
      })
    )
      setSingle(!single);
  }
  return (
    <>
      <Button variant="secondary" onClick={() => void changeMode()}>
        {single ? "开启多人协作" : "切回单人模式"}
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          void confirmation.confirm({
            title: "提交翻译阶段？",
            description: "服务器当前内容将保存为不可变版本。",
            cancelLabel: "返回修改",
            confirmLabel: "确认提交",
            details: (
              <SubmissionPunctuationWarnings results={exampleWarnings} />
            ),
          })
        }
      >
        提交翻译
      </Button>
      {confirmation.dialog}
    </>
  );
}
