import { Ellipsis } from 'lucide-react';
import { matchPath, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { getMoreItems, primaryNavigation } from './navigation';

export default function MobileNavigation({ moreOpen, onMore }: { moreOpen: boolean; onMore: () => void }) {
  const { account } = useAuth();
  const { pathname } = useLocation();
  const moreActive = getMoreItems(account?.role).some((item) => matchPath({ path: item.to, end: false }, pathname));

  return <nav aria-label="Mobile navigation" className="mobile-bottom-nav md:hidden print:hidden">
    {primaryNavigation.map((item) => <NavLink key={item.to} to={item.to}
      className={({ isActive }) => `mobile-nav-item${isActive ? ' mobile-nav-active' : ''}`}>
      <item.icon size={22} aria-hidden="true" />
      <span>{item.label}</span>
    </NavLink>)}
    <button type="button" aria-haspopup="dialog" aria-controls="more-navigation" aria-expanded={moreOpen}
      aria-current={moreActive ? 'true' : undefined} onClick={onMore}
      className={`mobile-nav-item${moreActive || moreOpen ? ' mobile-nav-active' : ''}`}>
      <Ellipsis size={22} aria-hidden="true" />
      <span>More</span>
    </button>
  </nav>;
}
