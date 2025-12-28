import fs from "node:fs";
import path from "node:path";

export function getAgentPrompt(variables: Record<string, string>) {
    // 1. 读取外部 Markdown 文件
    const filePath = path.join(process.cwd(), "src/prompts/agent_v1.md");
    let template = fs.readFileSync(filePath, "utf-8");

    // 2. 动态注入变量（如工具描述、当前日期、用户信息等）
    Object.keys(variables).forEach(key => {
        const regex = new RegExp(`{{${key}}}`, "g");
        template = template.replace(regex, variables[key] ?? "");
    });

    return template;
}
