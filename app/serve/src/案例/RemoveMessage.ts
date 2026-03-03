import { ChatOllama } from "@langchain/ollama";
import { MessagesAnnotation, StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ToolMessage, AIMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { tools, toolNode } from "./embeddings/tool.js"; // 假设路径正确
import { getAgentPrompt } from "./prompts/loader.js";
import { toolsCondition } from "@langchain/langgraph/prebuilt";

// 1. 定义增强型状态 (State)
const MyStateAnnotation = Annotation.Root({
    ...MessagesAnnotation.spec,
    userName: Annotation({
        reducer: (oldV, newV) => newV ?? oldV,
        default: () => "访客",
    }),
    summary: Annotation({
        reducer: (old, next) => next ?? old,
        default: () => "",
    }),
});

const llm = new ChatOllama({
    model: "qwen2.5:3b", // 示例模型
    temperature: 0,
});

/**
 * 节点 A: 模型推理 (Agent)
 */
async function callModel(state) {
    let systemPrompt = getAgentPrompt({
        currentTime: new Date().toLocaleString(),
        userName: state.userName
    });

    // 注入历史背景总结，确保即使删除了旧消息，AI 依然记得核心事实
    if (state.summary) {
        systemPrompt += `\n\n[历史背景总结]: ${state.summary}`;
    }

    systemPrompt += `\n注意：如果已有工具结果，请直接回答。若信息缺失，请调用工具。`;

    const lastMessage = state.messages[state.messages.length - 1];
    const isAfterTool = lastMessage instanceof ToolMessage;

    const activeModel = isAfterTool ? llm : llm.bindTools(tools);

    // 生产实践：此处依然保留 slice(-8) 作为给 LLM 的即时窗口，双重保险
    const response = await activeModel.invoke([
        { role: "system", content: systemPrompt },
        ...state.messages.slice(-8)
    ]);

    return { messages: [response] };
}

/**
 * 节点 B: 记忆管理 (Memory Management) - 核心新增逻辑
 * 负责确定“删除边界”并将信息转化为总结
 */
async function manageMemory(state) {
    const messages = state.messages;
    
    // 设定阈值：当消息超过 10 条时触发清理
    if (messages.length <= 10) return {};

    console.log("--- 正在进行生产级记忆压缩与清理 ---");

    // 1. 确定边界：保留最近的 4 条消息（包含当前对话），其余的进入待处理区
    const toProcess = messages.slice(0, messages.length - 4);
    
    // 2. 将待删除的消息转化为总结 (这里可以调用一个轻量级 LLM 专门做总结)
    // 为了示例简洁，我们简单拼接，实际建议通过 llm.invoke 总结
    const newSummaryContent = toProcess
        .filter(m => m instanceof HumanMessage || m instanceof AIMessage)
        .map(m => `${m._getType()}: ${m.content}`)
        .join("\n");

    const updatedSummary = state.summary 
        ? `之前总结: ${state.summary}\n新增背景: ${newSummaryContent}`
        : newSummaryContent;

    // 3. 生成物理删除指令 (RemoveMessage)
    // 我们删除所有的 ToolMessage（因为太占空间）和较旧的 Human/AI Message
    const deleteInstructions = toProcess.map(m => new RemoveMessage({ id: m.id }));

    return {
        summary: updatedSummary, // 更新总结字段
        messages: deleteInstructions // 触发 Reducer 从 State 中物理删除这些 ID 的消息
    };
}

// 2. 构建工作流
const workflow = new StateGraph(MyStateAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addNode("memory_manager", manageMemory) // 新增清理节点

    .addEdge(START, "agent")
    
    // Agent 决策逻辑
    .addConditionalEdges(
        "agent", 
        toolsCondition,
        {
            tools: "tools",
            // 如果不需要调用工具了，先去 memory_manager 清理一下再结束
            __end__: "memory_manager", 
        }
    )
    
    // 工具执行完回 Agent
    .addEdge("tools", "agent")
    
    // 清理完后正式结束
    .addEdge("memory_manager", END);

// 3. 编译导出
export const graph = workflow.compile();
