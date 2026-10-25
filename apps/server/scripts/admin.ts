import "reflect-metadata";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createApplication } from "../src/application.js";
import { loadEnvironment } from "../src/config/environment.js";
import { UsersService } from "../src/users/users.service.js";

if (!stdin.isTTY || !stdout.isTTY)
  throw new Error(
    "管理员命令必须在交互终端运行，禁止将临时密码重定向到文件或日志。",
  );
const mode = process.argv[2];
if (!["init", "recover"].includes(mode))
  throw new Error("使用 admin:init 或 admin:recover");
const prompt = createInterface({ input: stdin, output: stdout });
const environment = loadEnvironment();
const app = await createApplication(environment);
try {
  const username = (
    await prompt.question("管理员账户名（3–64 位英文字母或数字）：")
  )
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9]{3,64}$/.test(username)) throw new Error("账户名格式无效");
  let displayName = username;
  if (mode === "init") {
    displayName = (await prompt.question("成员昵称：")).trim();
    if (!displayName || displayName.length > 100)
      throw new Error("成员昵称需为 1–100 个字符");
  }
  const target = new URL(environment.databaseUrl);
  console.log(`目标数据库：${target.hostname}${target.pathname}`);
  const confirmation = await prompt.question(
    `输入 ${mode === "init" ? "INIT" : "RECOVER"} 确认${mode === "init" ? "创建首个管理员" : "重置管理员密码并撤销全部会话"}：`,
  );
  if (confirmation !== (mode === "init" ? "INIT" : "RECOVER"))
    throw new Error("操作取消");
  await app.init();
  const users = app.get(UsersService);
  const result =
    mode === "init"
      ? await users.initializeAdmin(username, displayName)
      : await users.recoverAdmin(username);
  console.log(
    `账户名：${result.user.username}\n临时密码（仅显示此次）：${result.temporaryPassword}\n首次登录后必须修改密码。请妥善保管并清理终端显示。`,
  );
} finally {
  prompt.close();
  await app.close();
}
