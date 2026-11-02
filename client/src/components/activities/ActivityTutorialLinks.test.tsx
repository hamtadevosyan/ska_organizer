import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ActivityTutorialLinks } from './ActivityTutorialLinks';
import type { TutorialLink } from '../../api/activities';

const video: TutorialLink = { title: 'Build a paper city', publisher: 'Synthetic teaching source', url: 'https://example.com/videos/paper-city' };

test('videos remain explicit external links with no embedded third-party content, and URLs are available for print', () => {
  const { container } = render(<ActivityTutorialLinks links={[video]} />);
  const link = screen.getByRole('link', { name: 'Build a paper city (opens in a new tab)' });
  expect(link).toHaveAttribute('href', video.url);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(screen.getByRole('region', { name: 'Related how-to videos' })).toHaveTextContent('These are examples.');
  expect(screen.getByText(video.url)).toHaveClass('print:block');
  expect(container.querySelector('iframe, video, audio, img, script')).toBeNull();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test.each(['javascript:alert(1)', 'data:text/html,bad', 'http://example.com/video', '//example.com/video',
  'https://user:secret@example.com/video', 'https:example.com/video', 'https://example.com\\video',
  'https://example.com/white space', 'https://example.com/\nvideo', 'not a URL'])('unsafe video address %s is not rendered', url => {
  render(<ActivityTutorialLinks links={[{ ...video, url }]} />);
  expect(screen.queryByRole('region', { name: 'Related how-to videos' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('legacy missing links render nothing and remove uses the original index without mutating the source', () => {
  const onRemove = vi.fn();
  const { rerender } = render(<ActivityTutorialLinks />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  const links = [{ ...video, url: 'javascript:alert(1)' }, video];
  rerender(<ActivityTutorialLinks links={links} onRemove={onRemove} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove video: Build a paper city' }));
  expect(onRemove).toHaveBeenCalledExactlyOnceWith(1);
  expect(links).toHaveLength(2);
});

test('video metadata is rendered as text and the displayed collection is bounded', () => {
  const { container } = render(<ActivityTutorialLinks links={Array.from({ length: 5 }, (_, index) => ({
    ...video, title: index === 0 ? '<img src=x onerror=alert(1)>' : 'Example ' + index,
  }))} />);
  expect(screen.getAllByRole('link')).toHaveLength(3);
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
});
