import { Building2, Boxes, ClipboardCheck, FileText, House, PackageCheck, Palette, ShoppingCart, Users, Utensils, WalletCards } from 'lucide-react';
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
  purchasing: { to: '/purchasing', label: 'Purchasing', icon: ShoppingCart },
  receiving: { to: '/receiving', label: 'Receipts', icon: PackageCheck },
  staff: { to: '/staff', label: 'Staff', icon: Users },
  reports: { to: '/reports', label: 'Reports', icon: FileText },
  billing: { to: '/billing', label: 'Tuition', icon: WalletCards, adminOnly: true },
  accounts: { to: '/accounts', label: 'Accounts', icon: Users, adminOnly: true },
  registrationForms: { to: '/registration-forms', label: 'Registration forms', icon: FileText, adminOnly: true },
} satisfies Record<string, NavigationItem>;

const allItems: NavigationItem[] = Object.values(navigation);
const classroomItems: NavigationItem[] = [
  { to: '/classroom', label: 'My class', icon: House },
  { to: '/classroom/children', label: 'Children', icon: Users },
  { to: '/classroom/activities', label: 'Activities', icon: Palette },
  { to: '/classroom/meals', label: 'Meals', icon: Utensils },
];
export const primaryNavigation: NavigationItem[] = [
  navigation.dashboard, navigation.attendance, navigation.activities, navigation.meals,
];

export function getNavigationItems(role?: Role) {
  if (role === 'teacher') return [...classroomItems, { to: '/classroom/attendance', label: 'Class attendance', icon: ClipboardCheck }];
  if (role === 'viewer') return classroomItems;
  return allItems.filter((item) => !item.adminOnly || role === 'admin');
}

export function getPrimaryNavigationItems(role?: Role) {
  return role === 'teacher' ? [classroomItems[0], { to: '/classroom/attendance', label: 'Attendance', icon: ClipboardCheck }, classroomItems[2], classroomItems[3]] : role === 'viewer' ? classroomItems : primaryNavigation;
}

export function getMoreItems(role?: Role) {
  return getNavigationItems(role).filter((item) => !getPrimaryNavigationItems(role).some((primary) => primary.to === item.to));
}
