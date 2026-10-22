import { render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import AppRoutes from './index';

const mounted = vi.hoisted(() => vi.fn());
vi.mock('../pages/Accounts', () => ({ default: () => { mounted('accounts'); return <p>Operational page</p>; } }));
vi.mock('../pages/RegistrationForms', () => ({ default: () => { mounted('forms'); return <p>Operational page</p>; } }));
vi.mock('../pages/Rooms', () => ({ default: () => { mounted('rooms'); return <p>Operational page</p>; } }));
vi.mock('../pages/RoomRoster', () => ({ default: () => { mounted('roster'); return <p>Operational page</p>; } }));
vi.mock('../pages/Children', () => ({ default: () => { mounted('children'); return <p>Operational page</p>; } }));
vi.mock('../pages/Attendance', () => ({ default: () => { mounted('attendance'); return <p>Operational page</p>; } }));
vi.mock('../pages/Dashboard', () => ({ default: () => { mounted('dashboard'); return <p>Operational page</p>; } }));
vi.mock('../pages/Inventory', () => ({ default: () => { mounted('inventory'); return <p>Operational page</p>; } }));
vi.mock('../pages/InventoryGroupOperation', () => ({ default: () => { mounted('operation'); return <p>Operational page</p>; } }));
vi.mock('../pages/Purchasing', () => ({ default: () => { mounted('purchasing'); return <p>Operational page</p>; } }));
vi.mock('../pages/Receiving', () => ({ default: () => { mounted('receiving'); return <p>Operational page</p>; } }));
vi.mock('../pages/Activities', () => ({ default: () => { mounted('activities'); return <p>Operational page</p>; } }));
vi.mock('../pages/Meals', () => ({ default: () => { mounted('meals'); return <p>Operational page</p>; } }));
vi.mock('../pages/Staff', () => ({ default: () => { mounted('staff'); return <p>Operational page</p>; } }));
vi.mock('../pages/WorkTime', () => ({ default: () => { mounted('work-time'); return <p>Work time page</p>; } }));
vi.mock('../pages/Payroll', () => ({ default: () => { mounted('payroll'); return <p>Private payroll page</p>; } }));
vi.mock('../pages/Reports', () => ({ default: () => { mounted('reports'); return <p>Operational page</p>; } }));
vi.mock('../pages/Classroom', () => ({ default: ({ section }: { section: string }) => <h1>Class {section}</h1> }));

vi.mock('../pages/TeacherCare', () => ({ default: ({ section }: { section: string }) => <h1>Teacher {section}</h1> }));

function CurrentPath() { const location = useLocation(); return <output aria-label="Current path">{location.pathname + location.search + location.hash}</output>; }

test.each(['/dashboard', '/children', '/rooms/another-class', '/attendance', '/activities', '/meals', '/staff', '/inventory', '/purchasing', '/receiving', '/reports', '/accounts', '/registration-forms', '/work-time', '/payroll', '/staff/work-time', '/staff/payroll', '/unknown'])('Class viewer deep link %s redirects before mounting an operational page', async path => {
  mounted.mockClear();
  render(<SignedIn account={{ ...testAccount, role: 'viewer', roomId: 'own-class' }}><MemoryRouter initialEntries={[path]}>
    <AppRoutes /><CurrentPath />
  </MemoryRouter></SignedIn>);
  expect(await screen.findByRole('heading', { name: 'Class overview' })).toBeVisible();
  expect(screen.getByLabelText('Current path')).toHaveTextContent('/classroom');
  expect(mounted).not.toHaveBeenCalled();
});

test.each(['children', 'activities', 'meals'])('Class viewer can open its %s page directly', section => {
  mounted.mockClear();
  render(<SignedIn account={{ ...testAccount, role: 'viewer', roomId: 'own-class' }}><MemoryRouter initialEntries={['/classroom/' + section]}>
    <AppRoutes />
  </MemoryRouter></SignedIn>);
  expect(screen.getByRole('heading', { name: 'Class ' + section })).toBeVisible();
  expect(mounted).not.toHaveBeenCalled();
});

test.each(['admin', 'editor'] as const)('%s retains the ordinary operational routes', role => {
  mounted.mockClear();
  render(<SignedIn account={{ ...testAccount, role }}><MemoryRouter initialEntries={['/staff']}><AppRoutes /></MemoryRouter></SignedIn>);
  expect(screen.getByText('Operational page')).toBeVisible();
  expect(mounted).toHaveBeenCalledWith('staff');
  const sections = within(screen.getByRole('navigation', { name: 'Staff sections' }));
  expect(sections.getByRole('link', { name: 'Staff information' })).toHaveAttribute('aria-current', 'page');
  expect(sections.queryByRole('link', { name: 'Pay & time' }) !== null).toBe(role === 'admin');
});


test.each(['/staff', '/children', '/attendance', '/accounts', '/inventory', '/work-time', '/payroll', '/staff/work-time', '/staff/payroll'])('Teacher deep link %s cannot mount global management', async path => {
  mounted.mockClear();
  render(<SignedIn account={{ ...testAccount, role: 'teacher', roomId: 'own-class' }}><MemoryRouter initialEntries={[path]}><AppRoutes /><CurrentPath /></MemoryRouter></SignedIn>);
  expect(await screen.findByRole('heading', { name: 'Class overview' })).toBeVisible();
  expect(mounted).not.toHaveBeenCalled();
});
test.each(['children', 'attendance'])('Teacher opens scoped %s directly', section => {
  render(<SignedIn account={{ ...testAccount, role: 'teacher', roomId: 'own-class' }}><MemoryRouter initialEntries={['/classroom/' + section]}><AppRoutes /></MemoryRouter></SignedIn>);
  expect(screen.getByRole('heading', { name: 'Teacher ' + section })).toBeVisible();
});

test.each([
  ['/staff/work-time', 'work-time', 'Work time page'],
  ['/staff/payroll', 'payroll', 'Private payroll page'],
])('administrator opens the Staff subsection %s directly', (path, expected, content) => {
  mounted.mockClear();
  render(<SignedIn account={{ ...testAccount, role: 'admin' }}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></SignedIn>);
  expect(screen.getByText(content)).toBeVisible();
  expect(mounted).toHaveBeenCalledWith(expected);
  const sections = screen.getByRole('navigation', { name: 'Staff sections' });
  expect(sections).toHaveTextContent('Staff information');
  expect(sections).toHaveTextContent('Work time');
  expect(sections).toHaveTextContent('Pay & time');
  const links = within(sections);
  expect(links.getByRole('link', { name: expected === 'work-time' ? 'Work time' : 'Pay & time' })).toHaveAttribute('aria-current', 'page');
  expect(links.getByRole('link', { name: 'Staff information' })).not.toHaveAttribute('aria-current');
});

test.each([
  ['/work-time?employee=example#review', '/staff/work-time?employee=example#review', 'Work time page'],
  ['/payroll?employee=example#history', '/staff/payroll?employee=example#history', 'Private payroll page'],
])('legacy management URL %s keeps its query and fragment', async (path, expected, content) => {
  render(<SignedIn account={{ ...testAccount, role: 'admin' }}><MemoryRouter initialEntries={[path]}><AppRoutes /><CurrentPath /></MemoryRouter></SignedIn>);
  expect(await screen.findByText(content)).toBeVisible();
  expect(screen.getByLabelText('Current path')).toHaveTextContent(expected);
});

test('editor Work time belongs to Staff without a private-pay subsection', () => {
  render(<SignedIn account={{ ...testAccount, role: 'editor' }}><MemoryRouter initialEntries={['/staff/work-time']}><AppRoutes /></MemoryRouter></SignedIn>);
  expect(screen.getByText('Work time page')).toBeVisible();
  const sections = within(screen.getByRole('navigation', { name: 'Staff sections' }));
  expect(sections.getAllByRole('link')).toHaveLength(2);
  expect(sections.getByRole('link', { name: 'Work time' })).toHaveAttribute('aria-current', 'page');
  expect(sections.queryByRole('link', { name: 'Pay & time' })).not.toBeInTheDocument();
});
