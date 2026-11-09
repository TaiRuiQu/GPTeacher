/** Shared plain text makes browser TTS offsets reproducible in server teaching context. */
export function toSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '。\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

export function looksLikePlaybackEcho(
  transcript: string,
  narration: string,
  heardOffset?: number,
): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const text = normalize(transcript);
  const heard =
    heardOffset === undefined ? narration : narration.slice(0, Math.max(0, heardOffset) + 24);
  return text.length >= 5 && normalize(heard).includes(text);
}
