/** 内置示例，便于离线演示与端到端主流程。 */
export const SAMPLE_WORKSPACE = `[shutters]
S1
S2
S3
S4

[rules]
# S1 与 S2 不能同时开启
S1 CLOSED OR S2 CLOSED
# S2 开启时 S3 必须开启
S2 CLOSED OR S3 OPEN
# S3 开启或 S4 开启（不能同时 CLOSED）
S3 OPEN OR S4 OPEN
# S1 关闭则 S4 必须关闭
S1 OPEN OR S4 CLOSED
`;
