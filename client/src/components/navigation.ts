import { Building2, Boxes, ClipboardCheck, FileText, House, Palette, Users, Utensils } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Role } from '../auth/context';

export type NavigationItem = { to: string; label: string; icon: LucideIcon; adminOnly?: boolean };

// Desktop and phone navigation share the same routes and account visibility rule.
const navigation = {
  dashboard: { to: '/dashboard', label: 'Home', icon: House },
  attendance: { to: '/attendance', label: 'Attendance', icon: ClipboardCheck },
  activities: { to: '/activities', label: 'Activities', icon: Palette },
  meals: { to: '/meals', label: 'Meals', icon: Utensils },
  children: { to: '/children', label: 'Children', icon: Users },
  rooms: { to: '/rooms', label: 'Rooms & Classes', icon: Building2 },
  inventory: { to: '/inventory', label: 'Inventory', icon: Boxes },
  staff: { to: '/staff', label: 'Staff', icon: Users },
  reports: { to: '/reports', label: 'Reports', icon: FileText },
  accounts: { to: '/accounts', label: 'Accounts', icon: Users, adminOnly: true },
} satisfies Record<string, NavigationItem>;

const allItems: NavigationItem[] = Object.values(navigation);
export const primaryNavigation: NavigationItem[] = [
  navigation.dashboard, navigation.attendance, navigation.activities, navigation.meals,
];

export function getNavigationItems(role?: Role) {
  return allItems.filter((item) => !item.adminOnly || role === 'admin');
}

export function getMoreItems(role?: Role) {
  return getNavigationItems(role).filter((item) => !primaryNavigation.some((primary) => primary.to === item.to));
}
