import { Building2, Boxes, CalendarDays, FileText, LayoutDashboard, Users, Utensils } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Role } from '../auth/context';

export type NavigationItem = { to: string; label: string; icon: LucideIcon; adminOnly?: boolean };

// Desktop and phone navigation share the same routes and account visibility rule.
const navigation = {
  attendance: { to: '/attendance', label: 'Attendance', icon: CalendarDays },
  children: { to: '/children', label: 'Children', icon: Users },
  rooms: { to: '/rooms', label: 'Rooms & Classes', icon: Building2 },
  dashboard: { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  inventory: { to: '/inventory', label: 'Inventory', icon: Boxes },
  activities: { to: '/activities', label: 'Activity Planner', icon: CalendarDays },
  meals: { to: '/meals', label: 'Meals', icon: Utensils },
  staff: { to: '/staff', label: 'Staff', icon: Users },
  reports: { to: '/reports', label: 'Reports', icon: FileText },
  accounts: { to: '/accounts', label: 'Accounts', icon: Users, adminOnly: true },
} satisfies Record<string, NavigationItem>;

const allItems: NavigationItem[] = Object.values(navigation);
export const primaryNavigation: NavigationItem[] = [
  { ...navigation.dashboard, label: 'Home' }, navigation.children, navigation.meals,
];

export function getNavigationItems(role?: Role) {
  return allItems.filter((item) => !item.adminOnly || role === 'admin');
}

export function getMoreItems(role?: Role) {
  return getNavigationItems(role).filter((item) => !primaryNavigation.some((primary) => primary.to === item.to));
}
