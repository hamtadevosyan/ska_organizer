export type PhotoIngredient = { name: string; unit: string; quantity: string; original: string };
export type PhotoTextLine = { text: string; confidence: number; box: { x: number; y: number; width: number; height: number } };
export type PhotoRecipe = { name: string; servings: string; ingredients: string };
const fraction: Record<string, string> = { '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '⅓': ' 1/3', '⅔': ' 2/3', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8' };
const amountPattern = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+)';
const amountStart = new RegExp(`^(${amountPattern})\\s*(.*)$`);
const stop = /^(?:instructions?|directions?|method|preparation|steps?|notes?|nutrition|allergens?)\b/i;
const heading = /^(?:ingredients?|you will need)\s*:?$/i;
const yieldLine = /(?:\b(?:serves|servings?\s*:|makes|yields?)\s*(\d+)\s*(?:servings?|portions?|people)?\b|\b(\d+)\s+(?:servings?|portions?)\b)/i;
export const cleanRecipeLine = (line: string) => line.trim().replace(/^(?:[•*»●·|]\s*|[-–]\s+)+/, '').replace(/\s+[|]$/, '').trim();
const clean = cleanRecipeLine;
const yieldOf = (line: string) => { const match = line.match(yieldLine); return match?.[1] || match?.[2] || ''; };
const scaleControl = /^(?:(?:[✓✔v]\s*)?(?:\d+\/)?\d+\s*[xX]\s*)+$/;
const amountLead = /^[\d½¼¾⅓⅔⅛⅜⅝⅞%¥]/;

export function reviewRecipeText(text: string, located: PhotoTextLine[] = []): PhotoRecipe {
  const lines = text.split(/\r?\n/).map(clean).filter(line => line && /[a-zA-Z]/.test(line) && !scaleControl.test(line));
  const start = lines.findIndex(line => heading.test(line));
  const yieldIndex = lines.findIndex(line => !!yieldOf(line));
  const confidence = (line: string) => located.find(value => clean(value.text) === line)?.confidence ?? 100;
  // An ingredient-only photo has no meal title. Do not use clipped headings,
  // serving controls or a low-confidence fragment as a made-up meal name.
  const before = lines.slice(0, start >= 0 ? start : yieldIndex >= 0 ? yieldIndex : 1);
  const name = (before.find(line => !yieldOf(line) && !heading.test(line) && !amountLead.test(line) &&
    !/^(?:recipe\s*:?$)/i.test(line) && confidence(line) >= 80 && /^[a-zA-Z][a-zA-Z\s,'’&()-]*$/.test(line)) || '').slice(0, 255);
  const yields = [...new Set(lines.map(yieldOf).filter(Boolean))];
  const servings = yields.length === 1 ? yields[0] : '';
  const firstIngredient = lines.findIndex(line => amountLead.test(line) && !yieldOf(line));
  const yieldBeforeIngredients = yieldIndex >= 0 && (firstIngredient < 0 || yieldIndex < firstIngredient);
  let candidates = lines.slice(start >= 0 ? start + 1 : yieldBeforeIngredients ? yieldIndex + 1 : (name ? 1 : 0));
  const end = candidates.findIndex(line => stop.test(line));
  if (end >= 0) candidates = candidates.slice(0, end);
  candidates = candidates.filter(line => !yieldOf(line) && !heading.test(line) && !scaleControl.test(line));
  return { name, servings, ingredients: candidates.join('\n') };
}

const recipeMeasure = /(?<![a-zA-Z])(?:cups?|teaspoons?|tablespoons?|tsp|tbsp|grams?|g|millilit(?:er|re)s?|ml|ounces?|oz|pounds?|lbs?|gallons?|gal|count|pieces?)\b/i;
function measureParts(line: string) {
  const value = clean(line), match = recipeMeasure.exec(value);
  return match ? { prefix: value.slice(0, match.index).trim(), rest: value.slice(match.index) } : undefined;
}
const normalizeFractions = (value: string) => value.replace(/[½¼¾⅓⅔⅛⅜⅝⅞]/g, char => fraction[char]).replace(/\s+/g, ' ').trim();
export function uncertainRecipeAmount(line: string): boolean {
  const parts = measureParts(line);
  if (!parts) return /[%¥?]/.test(clean(line).split(/\s+/).slice(0, 2).join(' '));
  const prefix = normalizeFractions(parts.prefix);
  return !new RegExp(`^${amountPattern}$`).test(prefix) || prefix.split(/[ /]+/).some(value => Number(value) === 0);
}
export function fractionChoices(line: string): { label: string; value: string }[] {
  const parts = measureParts(line);
  if (!parts || !uncertainRecipeAmount(line) || !(/[%¥?]|[YyVv][2348sS¼,%]/.test(parts.prefix) || /^\d+\s+\d+$/.test(parts.prefix))) return [];
  const whole = parts.prefix.match(/^(\d+)(?:\s*[^\d\s./]|\s+\d+$)/)?.[1];
  return ['1/4', '1/2', '3/4'].map(value => {
    const amount = whole ? `${whole} ${value}` : value;
    return { label: amount, value: `${amount} ${parts.rest}` };
  });
}

export function ingredientLines(text: string, servings: number): PhotoIngredient[] {
  return text.split(/\r?\n/).map(clean).filter(Boolean).map(original => {
    const normalized = normalizeFractions(original);
    const match = normalized.match(amountStart);
    const result: PhotoIngredient = { name: normalized, unit: '', quantity: '', original };
    if (!match) return result;
    const amount = match[1].split(/\s+/).reduce((sum, part) => {
      const pieces = part.split('/').map(Number);
      return sum + (pieces.length === 2 ? pieces[0] / pieces[1] : pieces[0]);
    }, 0);
    const tail = match[2];
    const unit = tail.match(/^(g|grams?|ml|millilit(?:er|re)s?|oz|ounces?|lb|lbs|pounds?|gal|gallons?|count|pieces?)\b\.?\s*(?:of\s+)?(.+)$/i);
    if (unit) {
      const label = unit[1].toLowerCase();
      result.unit = /^(g|grams?)$/.test(label) ? 'g' : /^(ml|milli)/.test(label) ? 'ml' : /^(oz|ounce)/.test(label) ? 'oz' : /^(lb|pound)/.test(label) ? 'lb' : /^(gal)/.test(label) ? 'gal' : 'count';
      result.name = unit[2];
    } else if (/^(?:(?:small|medium|large)\s+)?(?:eggs?|bananas?|apples?|pears?|oranges?|carrots?|potatoes|tomatoes|onions?)\b/i.test(tail)) {
      result.unit = 'count'; result.name = tail;
    } else {
      // Keep unfamiliar measures, ranges and package sizes visible. Never guess
      // that a cup, pinch, can or ambiguous number represents grams or a count.
      result.name = tail || normalized;
    }
    const perPerson = amount / servings;
    if (result.unit && Number.isFinite(perPerson) && perPerson > 0 && perPerson < 1e12 && Number(perPerson.toFixed(6)) > 0) result.quantity = String(Number(perPerson.toFixed(6)));
    return result;
  });
}

export async function prepareRecipeImage(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('Choose a recipe photo under 20 MB. JPEG, PNG and WebP work best.');
  const url = URL.createObjectURL(file);
  try {
    const photo = new Image();
    photo.src = url;
    try { await photo.decode(); } catch { throw new Error('This image format could not be opened. Export it as JPEG or PNG and try again.'); }
    if (!photo.naturalWidth || !photo.naturalHeight || photo.naturalWidth * photo.naturalHeight > 50000000) throw new Error('This photo is too large. Crop it to one recipe and try again.');
    const canvas = document.createElement('canvas');
    let scale = Math.min(1, 2200 / Math.max(photo.naturalWidth, photo.naturalHeight));
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(photo.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(photo.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser could not prepare the image. Try another browser.');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(photo, 0, 0, canvas.width, canvas.height);
      const encoded = canvas.toDataURL('image/png').split(',')[1];
      if (encoded && encoded.length <= Math.floor(5 * 1024 * 1024 / 3) * 4) return encoded;
      scale *= 0.75;
    }
    throw new Error('This image is too detailed. Crop it to one recipe and try again.');
  } finally { URL.revokeObjectURL(url); }
}
