import { useEffect, useId, useRef, useState } from 'react';
import axios from 'axios';
import { Camera, ImagePlus } from 'lucide-react';
import { API_BASE_URL } from '../../lib/api';
import { ingredientLines, prepareRecipeImage, reviewRecipeText } from './recipePhoto';
import type { PhotoIngredient } from './recipePhoto';

const button = 'ska-meal-idea-button min-h-11 min-w-11 rounded-xl border border-violet-200 bg-white px-4 py-2.5 font-semibold text-slate-800 disabled:opacity-50';
const input = 'ska-meal-idea-input mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
type Props = { disabled: boolean; onCancel: () => void; onReady: (name: string, rows: PhotoIngredient[]) => void };

export default function RecipePhotoImport({ disabled, onCancel, onReady }: Props) {
  const id = useId();
  const camera = useRef<HTMLInputElement>(null), upload = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [image, setImage] = useState(''), [text, setText] = useState('');
  const [name, setName] = useState(''), [servings, setServings] = useState('');
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => { heading.current?.focus(); return () => pending.current?.abort(); }, []);
  useEffect(() => { if (review) nameInput.current?.focus(); }, [review]);

  async function read(file?: File) {
    if (!file || busy || disabled) return;
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    setBusy(true); setError(''); setFields({}); setDiscard(false);
    try {
      const encoded = await prepareRecipeImage(file);
      if (controller.signal.aborted) return;
      setImage(encoded);
      const response = await axios.post(`${API_BASE_URL}/api/meals/recipe-photo`, { image: encoded }, { signal: controller.signal, timeout: 45000 });
      if (controller.signal.aborted) return;
      const extracted = reviewRecipeText(response.data.data.text);
      setName(extracted.name); setServings(extracted.servings); setText(extracted.ingredients);
      setConfirmed(false); setReview(true);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const message = axios.isAxiosError(failure) ? failure.response?.data?.error?.message : failure instanceof Error ? failure.message : '';
      setError(message || 'Could not read the recipe. Your entries are still here. Try the photo again.');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function useRecipe() {
    const invalid: Record<string, string> = {};
    if (!name.trim() || name.trim().length > 255) invalid.name = 'Enter a meal name between 1 and 255 characters.';
    const count = Number(servings);
    if (!Number.isInteger(count) || count < 1 || count > 1000) invalid.servings = 'Enter how many servings this whole recipe makes (1–1000).';
    const rows = ingredientLines(text, count);
    if (!rows.length || rows.length > 50) invalid.text = 'Keep one ingredient per line, with between 1 and 50 ingredients.';
    if (!confirmed) invalid.confirmed = 'Confirm the recipe servings and ingredient lines before continuing.';
    setFields(invalid);
    if (Object.keys(invalid).length) return;
    onReady(name.trim(), rows);
  }
  const props = (key: string) => ({ id: `${id}-${key}`, 'aria-invalid': !!fields[key], 'aria-describedby': fields[key] ? `${id}-${key}-error` : undefined });
  const fieldError = (key: string) => fields[key] && <p id={`${id}-${key}-error`} className="mt-1 text-sm text-red-700">{fields[key]}</p>;
  const changed = () => { setConfirmed(false); setFields({}); };

  return <section aria-label="Import recipe photo" className="min-w-0 space-y-4">
    <div><h4 ref={heading} tabIndex={-1} className="text-xl font-bold text-slate-900">Turn a recipe photo into a meal</h4>
      <p className="mt-1 text-sm text-slate-600">Photograph a written recipe or choose an image. Clear, upright printed English works best. Review everything before saving.</p>
      <p className="mt-2 text-sm text-violet-800">Read on your facility’s server. Photos are not kept.</p></div>
    {!review && <div className="flex flex-wrap gap-3">
      <button type="button" className={button} disabled={busy || disabled} onClick={() => camera.current?.click()}><Camera aria-hidden="true" className="mr-2 inline-block h-5 w-5" />Take recipe photo</button>
      <button type="button" className={button} disabled={busy || disabled} onClick={() => upload.current?.click()}><ImagePlus aria-hidden="true" className="mr-2 inline-block h-5 w-5" />Upload recipe image</button>
    </div>}
    <input ref={camera} type="file" accept="image/*" capture="environment" aria-label="Recipe camera image" hidden onChange={event => { void read(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={upload} type="file" accept="image/*" aria-label="Recipe image file" hidden onChange={event => { void read(event.target.files?.[0]); event.target.value = ''; }} />
    {busy && <p role="status" className="rounded-xl bg-violet-50 p-3">Reading your recipe… This can take up to 30 seconds.</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">{error}</p>}
    {image && <details><summary className="min-h-11 cursor-pointer py-3 font-semibold">View recipe photo</summary><img src={`data:image/png;base64,${image}`} alt="Recipe selected for text review" className="max-h-96 max-w-full rounded-xl object-contain" /></details>}
    {review && <fieldset disabled={busy || disabled} className="min-w-0 space-y-4">
      <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Check the recognized text against the photo, especially fractions, units and servings. Keep ingredients only, one per line.</p>
      <div><label htmlFor={`${id}-name`}>Recipe meal name</label><input ref={nameInput} {...props('name')} value={name} className={input} onChange={event => { setName(event.target.value); changed(); }} />{fieldError('name')}</div>
      <div><label htmlFor={`${id}-servings`}>Recipe makes how many servings?</label><input {...props('servings')} type="number" min="1" max="1000" step="1" value={servings} className={input} onChange={event => { setServings(event.target.value); changed(); }} />
        <p className="mt-1 text-sm text-slate-600">We divide recognized amounts by this number to fill quantities per person.</p>{fieldError('servings')}</div>
      <div><label htmlFor={`${id}-text`}>Recipe ingredient lines</label><textarea {...props('text')} rows={8} maxLength={24000} value={text} className={input} onChange={event => { setText(event.target.value); changed(); }} />{fieldError('text')}</div>
      <label className="flex min-h-11 items-center gap-3" htmlFor={`${id}-confirmed`}><input {...props('confirmed')} type="checkbox" checked={confirmed} className="min-h-11 min-w-11 accent-violet-700" onChange={event => setConfirmed(event.target.checked)} />I checked the servings and ingredient lines.</label>{fieldError('confirmed')}
      <button type="button" className={`${button} !bg-violet-700 !text-white`} onClick={useRecipe}>Use recipe in meal draft</button>
    </fieldset>}
    <button type="button" className={button} onClick={() => { if (image || text || busy) setDiscard(true); else onCancel(); }}>Cancel photo import</button>
    {discard && <div role="group" aria-label="Discard recipe photo" className="rounded-xl bg-amber-50 p-3"><p>Discard this photo and its unsaved recipe text?</p><div className="mt-3 flex flex-wrap gap-3">
      <button type="button" className={button} onClick={() => setDiscard(false)}>Keep editing photo</button>
      <button type="button" className={button} onClick={() => { pending.current?.abort(); onCancel(); }}>Discard photo</button>
    </div></div>}
  </section>;
}
