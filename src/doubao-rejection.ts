const REFUSAL_PATTERN = /(?:抱歉[^。！？\n]{0,80}(?:无法|不能|暂时不能)[^。！？\n]{0,80}(?:生成|完成|提供|满足|处理)|(?:无法|不能|暂不支持)[^。！？\n]{0,60}(?:生成|完成|提供|处理)|(?:换个|更换|改个|尝试其他)[^。！？\n]{0,40}(?:需求|描述|内容|主题)|(?:不便|不能)为你生成)/i;

function normalizedLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Finds a newly appended Doubao refusal. Existing refusal messages in an old
 * conversation are ignored, while a repeated identical refusal is detected by
 * comparing how many times that line occurs before and after submission.
 */
export function detectDoubaoRejection(beforeText: string, afterText: string) {
  const beforeLines = normalizedLines(beforeText);
  const afterLines = normalizedLines(afterText);
  const beforeCounts = new Map<string, number>();
  const seenAfter = new Map<string, number>();
  for (const line of beforeLines) beforeCounts.set(line, (beforeCounts.get(line) || 0) + 1);

  for (const line of afterLines) {
    const count = (seenAfter.get(line) || 0) + 1;
    seenAfter.set(line, count);
    if (!REFUSAL_PATTERN.test(line)) continue;
    if (count <= (beforeCounts.get(line) || 0)) continue;
    return line.slice(0, 500);
  }
  return "";
}

export function refusalFailureMessage(responseText: string, refusalCount: number) {
  const count = Math.max(1, Math.round(refusalCount));
  return `豆包拒绝生成（可能是偶发误判，累计 ${count} 次）：${responseText}`;
}
