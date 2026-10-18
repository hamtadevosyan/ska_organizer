import { render, screen } from '@testing-library/react';
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
vi.mock('../pages/Reports', () => ({ default: () => { mounted('reports'); return <p>Operational page</p>; } }));
vi.mock('../pages/Classroom', () => ({ default: ({ section }: { section: string }) => <h1>Class {section}</h1> }));

function CurrentPath() { return <output aria-label="Current path">{useLocation().pathname}</output>; }

test.each(['/dashboard', '/children', '/rooms/another-class', '/attendance', '/activities', '/meals', '/staff', '/inventory', '/purchasing', '/receiving', '/reports', '/accounts', '/registration-forms', '/unknown'])('Class viewer deep link %s redirects before mounting an operational page', async path => {
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
});
