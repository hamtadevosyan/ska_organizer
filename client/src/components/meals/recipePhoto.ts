export type PhotoIngredient = { name: string; unit: string; quantity: string; original: string };
export type PhotoRecipe = { name: string; servings: string; ingredients: string };
const fraction: Record<string, string> = { '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '⅓': ' 1/3', '⅔': ' 2/3', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8' };
const amountPattern = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+)';
const amountStart = new RegExp(`^(${amountPattern})\\s*(.*)$`);
const stop = /^(?:instructions?|directions?|method|preparation|steps?|notes?|nutrition|allergens?)\b/i;
const heading = /^(?:ingredients?|you will need)\s*:?$/i;
const yieldLine = /^(?:serves|servings?\s*:|makes)\s*(\d+)\s*(?:servings?|portions?|people)?\s*$/i;
const clean = (line: string) => line.trim().replace(/^(?:[•*]\s*|[-–]\s+)/, '').trim();

export function reviewRecipeText(text: string): PhotoRecipe {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const start = lines.findIndex(line => heading.test(line));
  const name = (lines.slice(0, start >= 0 ? start : 1).find(line => !yieldLine.test(line) && !heading.test(line) && !/^(?:recipe\s*:?$|[\d½¼¾⅓⅔⅛⅜⅝⅞])/.test(line)) || '').slice(0, 255);
  const servings = lines.map(line => line.match(yieldLine)?.[1]).find(Boolean) || '';
  let candidates = lines.slice(start >= 0 ? start + 1 : (name ? 1 : 0));
  const end = candidates.findIndex(line => stop.test(line));
  if (end >= 0) candidates = candidates.slice(0, end);
  candidates = candidates.filter(line => !yieldLine.test(line) && !heading.test(line));
  return { name, servings, ingredients: candidates.join('\n') };
}

export function ingredientLines(text: string, servings: number): PhotoIngredient[] {
  return text.split(/\r?\n/).map(clean).filter(Boolean).map(original => {
    const normalized = original.replace(/[½¼¾⅓⅔⅛⅜⅝⅞]/g, value => fraction[value]).trim();
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
    } else if (/^(?:eggs?|bananas?|apples?|pears?|oranges?|carrots?|potatoes|tomatoes|onions?)\b/i.test(tail)) {
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
