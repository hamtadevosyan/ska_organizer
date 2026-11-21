// Fixed publisher pages checked on 2026-11-02. These are optional demonstrations,
// not age approvals or regulatory references. Match only AFTER an independent
// activity has been generated; a tiny video collection must not limit its ideas.
// Keep this small collection reviewed when adding or replacing a publisher page.
const examples = [
  {
    id: 'pbs-shape-collage', title: 'Create Colorful Collages to Learn About Shapes',
    publisher: 'PBS SoCal — Family Math',
    url: 'https://www.pbs.org/video/create-colorful-collages-to-learn-about-shapes/',
    summary: 'An adult and child find shapes in paper pictures and arrange them into a collage. Related to paper shape collages, not every sorting or color activity.',
  },
  {
    id: 'pbs-newspaper-city', title: 'Make a Newspaper City to Develop Spatial Sense',
    publisher: 'PBS SoCal — Family Math',
    url: 'https://www.pbs.org/video/make-a-newspaper-city-to-develop-spatial-sense/',
    summary: 'Make a structure from newspaper and tape while talking about positions. Related to paper construction, not generic block play.',
  },
  {
    id: 'pbs-number-bingo', title: 'Learn to Count With Number Bingo',
    publisher: 'PBS SoCal — Family Math',
    url: 'https://www.pbs.org/video/learn-to-count-with-number-bingo/',
    summary: 'An adult and child make and play a counting bingo board. Related to number bingo, not every counting activity.',
  },
  {
    id: 'pbs-pattern-loom', title: 'Build a Loom to Weave Your Own Patterns',
    publisher: 'PBS SoCal — Family Math',
    url: 'https://www.pbs.org/video/build-a-loom-to-weave-your-own-patterns/',
    summary: 'An adult and child make a simple loom and weave patterns. Related to weaving; adult review of cords, tools and age suitability is essential.',
  },
];

function search(guide) {
  // A search is an explicit fallback, not a selected or reviewed video. Keep
  // the query to the generated activity name; never append its full context.
  const name = Array.from((typeof guide.name === 'string' ? guide.name : '')
    .normalize('NFKC').replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim());
  const url = new URL('https://www.youtube.com/results');
  do {
    url.searchParams.set('search_query', [name.join('').trim(), 'preschool activity how to'].filter(Boolean).join(' '));
    if (url.href.length <= 500) return [{ title: 'Search YouTube for how-to videos', publisher: 'YouTube', url: url.href, kind: 'search' }];
    name.pop();
  } while (name.length);
  return [];
}

function match(guide) {
  // Use the core procedure and materials, not incidental questions/safety notes.
  // This deliberately misses ambiguous examples rather than forcing a video.
  const content = [guide.name, guide.purpose, guide.preparation, ...(guide.steps || []), guide.materialsNotes]
    .filter(value => typeof value === 'string').join(' ').normalize('NFKC').toLowerCase();
  const rules = {
    'pbs-shape-collage': () => /\bcollages?\b/.test(content) && /\bshapes?\b/.test(content) &&
      /\bpaper\b/.test(content) && /\b(glue|gluing|stick|sticking|attach\w*)\b/.test(content),
    'pbs-newspaper-city': () => /\bnewspaper\b/.test(content) && /\b(build\w*|construct\w*|structures?|towers?|city|town)\b/.test(content),
    'pbs-number-bingo': () => /\bbingo\b/.test(content) && /\b(numbers?|numerals?|count\w*)\b/.test(content),
    'pbs-pattern-loom': () => /\b(weav\w*|loom)\b/.test(content) && /\b(patterns?|threads?|yarn)\b/.test(content),
  };
  const example = examples.find(value => rules[value.id]());
  if (!example) return search(guide);
  const { title, publisher, url } = example;
  return [{ title, publisher, url }];
}

module.exports = { match };
