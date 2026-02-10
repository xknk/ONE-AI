/*
 * @Author: Robin LEI
 * @Date: 2026-02-05 16:33:04
 * @LastEditTime: 2026-02-05 16:33:12
 * @FilePath: \ONE-AI\app\serve\src\embeddings\memoryTool.ts
 */
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { addMessageToVectorStore, retrieveRelevantHistory } from "./mxbai-embed-large.js";

/**
 * 记忆检索工具类
 */
export class QueryMemoryTool extends StructuredTool {
    name = "query_memory";
    // 这里的描述依然保持对小模型的强引导
    description = "首选工具。查询用户的历史偏好或背景。如果返回 [MISSING_MEMORY]，必须立即改用 'serachTool' 联网搜索。";
    
    schema = z.object({
        query: z.string().describe("检索关键词，如'用户的名字'、'昨天的聊天内容'")
    });

    // 这里可以定义私有变量，比如数据库连接实例等
    constructor() {
        super();
    }

    async _call({ query }: z.infer<typeof this.schema>, runManager?: any, config?: any): Promise<string> {
        // 从 config 中安全获取 sessionId
        const sessionId = config?.configurable?.sessionId;
        
        try {
            const result = await retrieveRelevantHistory(query, sessionId);
            console.log("【QueryMemoryTool 类检索结果】", result);

            if (!result || result.includes("无相关背景信息") || result.includes("出错")) {
                return "[MISSING_MEMORY]";
            }
            return `找到相关历史背景：\n${result}`;
        } catch (error) {
            console.error("QueryMemoryTool Error:", error);
            return "[MISSING_MEMORY]";
        }
    }
}

/**
 * 记忆存储工具类
 */
export class SaveMemoryTool extends StructuredTool {
    name = "save_memory";
    description = "记忆存储工具。当用户提到关键事实（如：姓名、偏好）时，必须调用此工具进行记录。";
    
    schema = z.object({
        content: z.string().describe("需要存储的核心事实陈述，建议格式：'用户：[姓名]，特征：[事实]'")
    });

    constructor() {
        super();
    }

    async _call({ content }: z.infer<typeof this.schema>, runManager?: any, config?: any): Promise<string> {
        const sessionId = config?.configurable?.sessionId;
        try {
            await addMessageToVectorStore(sessionId, "Agent自主提取", content);
            return "【系统提示】信息已成功持久化存储。";
        } catch (error) {
            console.error("SaveMemoryTool Error:", error);
            return "【系统提示】存储失败。";
        }
    }
}
