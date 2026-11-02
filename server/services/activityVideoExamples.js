// Fixed publisher pages checked on 2026-11-02. These are optional demonstrations,
// not age approvals or regulatory references. The model receives IDs and brief
// descriptions only; URLs are resolved here and are never invented by inference.
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

function forModel() {
  return examples.map(({ id, title, summary }) => ({ id, title, summary }));
}

function resolve(ids, available) {
  if (!Array.isArray(ids) || ids.length > 1 || ids.some(id => typeof id !== 'string' || !available.some(example => example.id === id))) throw new Error('Unknown video example.');
  return ids.map(id => {
    const { title, publisher, url } = examples.find(example => example.id === id);
    return { title, publisher, url };
  });
}

module.exports = { forModel, resolve };
