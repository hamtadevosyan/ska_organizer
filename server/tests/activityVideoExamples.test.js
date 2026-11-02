const videos = require('../services/activityVideoExamples');

const guide = (changes = {}) => ({ name: 'Color story circle', purpose: 'Tell a shared color story.',
  preparation: 'Set out large colorful picture cards.', materialsNotes: 'Large picture cards.',
  steps: ['Show the colorful picture cards.', 'Choose a favorite picture.', 'Describe the picture to the group.', 'Tell a story together.'], ...changes });
const collage = guide({ name: 'Paper shape collage', purpose: 'Explore shapes by creating a collage.',
  preparation: 'Cut large paper shapes and set out glue.', materialsNotes: 'Paper shapes, a paper base and washable glue.',
  steps: ['Choose large paper shapes.', 'Arrange shapes on the paper.', 'Attach the shapes to the paper with glue.', 'Show the finished collage.'] });

test.each([
  ['paper shape collage', collage, 'https://www.pbs.org/video/create-colorful-collages-to-learn-about-shapes/'],
  ['newspaper construction', guide({ name: 'Build a newspaper town', materialsNotes: 'Newspaper and tape.',
    steps: ['Roll newspaper into tubes.', 'Build low newspaper structures together.', 'Tape the paper buildings to a cardboard base.', 'Describe the positions in the finished city.'] }),
  'https://www.pbs.org/video/make-a-newspaper-city-to-develop-spatial-sense/'],
  ['number bingo', guide({ name: 'Number bingo', materialsNotes: 'Number cards and a large bingo board.',
    steps: ['Make a simple number bingo board.', 'Call one number at a time.', 'Find the matching number on the board.', 'Count the marked numbers together.'] }),
  'https://www.pbs.org/video/learn-to-count-with-number-bingo/'],
  ['pattern weaving', guide({ name: 'Weave a pattern on a simple loom', materialsNotes: 'A prepared loom and paper strips.',
    steps: ['Show the prepared loom.', 'Choose two colors for a weaving pattern.', 'Weave a paper strip over and under with adult support.', 'Describe the pattern on the finished loom.'] }),
  'https://www.pbs.org/video/build-a-loom-to-weave-your-own-patterns/'],
])('a related %s procedure resolves to one fixed publisher link', (label, activity, url) => {
  const result = videos.match(activity);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ publisher: 'PBS SoCal — Family Math', url });
  expect(Object.keys(result[0]).sort()).toEqual(['publisher', 'title', 'url']);
  expect(result[0].title).toBeTruthy();
});

test.each([
  ['a story activity', guide()],
  ['a shape hunt', guide({ name: 'Shape scavenger hunt', purpose: 'Find shapes in the room.',
    materialsNotes: 'Paper shape cards.', steps: ['Look for a large circle.', 'Find a square together.', 'Point to a triangle.', 'Describe the shapes that were found.'] })],
  ['block building', guide({ name: 'Build a block town', materialsNotes: 'Large wooden blocks.',
    steps: ['Choose large blocks.', 'Build low towers.', 'Connect two towers with a block road.', 'Describe the finished city.'] })],
  ['generic counting', guide({ name: 'Count the large blocks', materialsNotes: 'Large blocks.',
    steps: ['Choose two blocks.', 'Count the blocks together.', 'Add another block.', 'Count the new total.'] })],
  ['incidental questions or safety notes', guide({ safety: 'Keep old newspaper and paper weaving looms away from the work area.',
    conversationPrompts: ['Have you played number bingo?', 'Have you made a paper shape collage?'] })],
])('%s does not get an unrelated video just to fill the optional field', (label, activity) => {
  expect(videos.match(activity)).toEqual([]);
});

test('returned video metadata cannot mutate the fixed publisher collection', () => {
  const first = videos.match(collage);
  first[0].url = 'https://untrusted.invalid/changed';
  first[0].title = 'Changed title';
  expect(videos.match(collage)[0]).toMatchObject({ title: 'Create Colorful Collages to Learn About Shapes',
    url: 'https://www.pbs.org/video/create-colorful-collages-to-learn-about-shapes/' });
});
