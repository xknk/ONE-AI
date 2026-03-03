/*
 * @Author: Robin LEI 输入案例模板
 * @Date: 2026-02-11 10:50:33
 * @LastEditTime: 2026-02-11 11:40:51
 * @FilePath: \ONE-AI\app\serve\src\案例\FewShotPromptTemplate.ts
 */
import { FewShotPromptTemplate, PromptTemplate } from "@langchain/core/prompts";

// 1. 定义例子的结构模板
const examplePrompt = PromptTemplate.fromTemplate(
  "输入: {input}\n输出: {output}"
);

// 2. 准备一些高质量的“打样”例子
const examples = [
  { input: "这产品太棒了", output: "正向反馈" },
  { input: "物流太慢了，差评", output: "负向反馈" },
];

// 3. 创建 FewShotPromptTemplate
const dynamicPrompt = new FewShotPromptTemplate({
  examples,
  examplePrompt,
  prefix: "你是一个评论分析助手，请模仿以下风格对输入进行分类：",
  suffix: "输入: {text}\n输出:",
  inputVariables: ["text"],
});

// 4. 格式化生成最终发送给 AI 的字符串
const finalPrompt = await dynamicPrompt.format({ text: "屏幕显示效果一般" });
console.log(finalPrompt);
