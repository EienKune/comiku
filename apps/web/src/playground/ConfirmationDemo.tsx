import { useState } from "react";
import { Button } from "../components/ui";
import { useConfirmation } from "../components/use-confirmation";

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
      {confirmation.dialog}
    </>
  );
}
