import type { TutorialLink } from '../../api/activities';

function usable(link: TutorialLink) {
  if (!link || typeof link.title !== 'string' || !link.title.trim() || typeof link.publisher !== 'string' ||
      typeof link.url !== 'string' || link.url.length > 500 || !/^https:\/\//i.test(link.url) || /[\\\s]/.test(link.url) ||
      [...link.url].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const address = new URL(link.url);
    return address.protocol === 'https:' && !!address.hostname && !address.username && !address.password &&
      (link.kind !== 'search' || (['youtube.com', 'www.youtube.com'].includes(address.hostname) && address.pathname === '/results' && !!address.searchParams.get('search_query')?.trim()));
  } catch { return false; }
}

// Plain links load no third-party players, thumbnails or scripts in Organizer.
export function ActivityTutorialLinks({ links, onRemove }: {
  links?: TutorialLink[] | null; onRemove?: (index: number) => void;
}) {
  const videos = (Array.isArray(links) ? links : []).map((link, index) => ({ link, index })).filter(({ link }) => usable(link)).slice(0, 3);
  if (!videos.length) return null;
  const examples = videos.filter(({ link }) => link.kind !== 'search');
  const searches = videos.filter(({ link }) => link.kind === 'search');
  const list = (values: typeof videos) => <ul className="space-y-2">{values.map(({ link, index }) => <li key={index}>
    <a href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="font-semibold text-violet-800 underline">
      {link.title}<span className="sr-only"> (opens in a new tab)</span>
    </a>
    {link.publisher && <span> · {link.publisher}</span>}
    {link.kind === 'search' && <span className="ml-2 font-semibold">Unreviewed search</span>}
    <span className="hidden break-all print:block">{link.url}</span>
    {onRemove && <button type="button" aria-label={(link.kind === 'search' ? 'Remove video search: ' : 'Remove video: ') + link.title} className="ml-3 rounded border bg-white px-3 py-2 print:hidden" onClick={() => onRemove(index)}>{link.kind === 'search' ? 'Remove search' : 'Remove video'}</button>}
  </li>)}</ul>;
  return <section aria-label="Related how-to videos" className="mt-3 space-y-2 break-words rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm print:border-0 print:bg-white print:p-0">
    {!!examples.length && <><h3 className="font-bold">Related how-to videos</h3>
      <p>These are examples. Check the materials, ages and supervision before using them. Video websites open in a new tab.</p>{list(examples)}</>}
    {!!searches.length && <><h3 className="font-bold">Find how-to videos</h3>
      <p>These links open YouTube search results, not a selected or reviewed video. Check the demonstration, materials, ages and supervision before using it.</p>{list(searches)}</>}
  </section>;
}
