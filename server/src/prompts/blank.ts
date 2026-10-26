export function blankPrompt(itemsEn: string[]): string {
  const items = itemsEn.join(', ')
  return `Recreate this exact image with one single difference. Do NOT generate the following personalized placeholder content: ${items}. Where that content was, show only the natural continuation of the existing background or product surface. Do not add any replacement element, silhouette, frame, box, watermark or placeholder text there. Keep everything else identical to the source image: the product, its shape, position and framing, the background, lighting and shadows, and all other decorative elements and text such as poems, quotes and captions must stay exactly as they are, fully legible and unchanged.`
}
