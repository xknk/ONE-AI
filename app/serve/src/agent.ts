/*
 * @Author: Robin LEI
 * @Date: 2025-12-17 14:41:24
 * @LastEditTime: 2026-01-30 17:17:31
 * @Description: 优化后的 LangGraph Agent，强化了工具调用逻辑与模型响应控制
 */
import { ChatOllama } from "@langchain/ollama";
import { MessagesAnnotation, StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { tools, toolNode } from "./embeddings/tool.js";
import { getAgentPrompt } from "./prompts/loader.js"
import { ToolMessage, AIMessage } from "@langchain/core/messages";
import { toolsCondition } from "@langchain/langgraph/prebuilt";
import { getConfig  } from "./config/env.js";
const config = getConfig();
// 1. 初始化 LLM 模型
// 注意：对于 Agent 工具调用，建议 temperature 设为 0 以保证逻辑稳定
const llm = new ChatOllama({
    model: config.ollama.model,
    baseUrl: config.ollama.baseUrl,
    topP: config.ollama.topP,
    topK: config.ollama.topK,
    streaming: config.ollama.streaming,
    temperature: 0, // 强制 0，防止模型在调用工具时产生幻觉废话
    repeatPenalty: config.ollama.repeatPenalty,
    numPredict: config.ollama.numPredict,
});

// 2. 定义全局状态 (State)
const MyStateAnnotation = Annotation.Root({
    ...MessagesAnnotation.spec,
    userName: Annotation<string>({
        reducer: (oldV, newV) => newV ?? oldV,
        default: () => "访客",
    }),
    summary: Annotation<string>({
        reducer: (old, next) => next ?? old
    }),
});

// 3. 节点逻辑：模型推理
async function callModel(state: typeof MyStateAnnotation.State) {
    let systemPrompt = getAgentPrompt({
        currentTime: new Date().toLocaleString(),
        userName: state.userName || "访客"
    });

    // 核心逻辑约束
    systemPrompt += `
    ## 严格指令
    1. 当你需要查询信息时，**必须直接调用工具**，严禁在回复中说“我帮您查一下”、”让我查一下“或“正在搜索”等多种回答。
    2. 如果 'query_memory' 返回 [MISSING_MEMORY]，必须立即调用 'serachTool'。
    4. 如果 'query_memory' 返回没有查到任何信息时必须立即调用 'serachTool'。
    3. 如果上一条消息是工具返回的结果，请直接整合信息回答用户。
    `;

    if (state.summary) {
        systemPrompt += `\n\n[历史背景总结]: ${state.summary}`;
    }

    const lastMessage = state.messages[state.messages.length - 1];
    const isAfterTool = lastMessage instanceof ToolMessage;

    let activeModel;
    if (isAfterTool) {
        // 场景 A：工具已返回结果，禁止模型再次生成 tool_calls，强制其总结陈词
        activeModel = llm; 
        systemPrompt += "\n\n重要：工具执行已结束。请用亲切的中文直接回答用户，不要再尝试调用任何工具。";
    } else {
        // 场景 B：正常对话，绑定工具。
        // 为防止模型由于性能弱而“光说话不干活”，在此处加强提示
        activeModel = llm.bindTools(tools);
        systemPrompt += "\n\n注意：如果用户请求涉及事实查询、天气、知识检索，请立即使用工具。";
    }

    const response = await activeModel.invoke([
        { role: "system", content: systemPrompt },
        ...state.messages.slice(-8) // 截取最近对话，防止上下文过长干扰 3b 模型判断
    ]);

    return { messages: [response] };
}

// 4. 构建工作流图 (LangGraph)
const workflow = new StateGraph(MyStateAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    // 使用官方 toolsCondition，它会自动处理 tool_calls 的存在性判定
    .addConditionalEdges(
        "agent", 
        toolsCondition,
        {
            // 如果模型生成了 tool_calls，跳转到 tools 节点
            tools: "tools",
            // 否则直接结束
            __end__: END,
        }
    )
    .addEdge("tools", "agent");

// 5. 编译并导出
export const graph = workflow.compile();
