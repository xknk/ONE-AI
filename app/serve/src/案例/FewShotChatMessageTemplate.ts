/*
 * @Author: Robin LEI 聊天时，输入案例模板
 * @Date: 2026-02-11 11:04:19
 * @LastEditTime: 2026-02-11 11:04:34
 * @FilePath: \ONE-AI\app\serve\src\案例\FewShotChatMessageTemplate.ts
 */
import {
  ChatPromptTemplate,
  FewShotChatMessagePromptTemplate,
} from "@langchain/core/prompts";

// 1. 定义示例的格式（通常是 Human 问，AI 答）
const examplePrompt = ChatPromptTemplate.fromMessages([
  ["human", "{input}"],
  ["ai", "{output}"],
]);

// 2. 编写打样数据
const examples = [
  { input: "帮我查一下去北京的机票", output: "Action: call_tool(find_flight, {city: '北京'})" },
  { input: "看看上海明天的天气", output: "Action: call_tool(get_weather, {city: '上海', date: 'tomorrow'})" },
];

// 3. 创建聊天版的 Few-Shot 模板
const fewShotPrompt = new FewShotChatMessagePromptTemplate({
  examplePrompt,
  examples,
  inputVariables: ["input"],
});

// 4. 组装成最终的对话模板
const finalChatPrompt = ChatPromptTemplate.fromMessages([
  ["system", "你是一个严格按照格式输出的指令解析器。"],
  fewShotPrompt, // 注入打样对话
  ["human", "{input}"], // 用户真实提问
]);

// 5. 调用
const formattedMessages = await finalChatPrompt.formatMessages({
  input: "搜一下广州后天的酒店",
});
