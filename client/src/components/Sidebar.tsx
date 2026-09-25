import { Sun } from 'lucide-react';
import { useAuth } from '../auth/context';
import { Link, NavLink } from 'react-router-dom';
import AcademyBrand from './AcademyBrand';
import { getNavigationItems } from './navigation';

export default function Sidebar() {
  const { account } = useAuth();
  return <aside className="app-sidebar print:hidden">
    <Link to="/dashboard" className="app-brand-link" aria-label="Smart Kids Academy home"><AcademyBrand /></Link>
    <p className="ska-kicker sidebar-label">Your workspace</p>
    <nav aria-label="Desktop navigation" className="desktop-navigation">
      {getNavigationItems(account?.role).map((item) => <NavLink key={item.to} to={item.to}
        className={({ isActive }) => `desktop-nav-item${isActive ? ' desktop-nav-active' : ''}`}>
        <span className={`desktop-nav-icon nav-${item.to.slice(1)}`}><item.icon size={20} aria-hidden="true" /></span>
        <span>{item.label}</span><span className="nav-current-dot" aria-hidden="true" />
      </NavLink>)}
    </nav>
    <div className="sidebar-note"><span><Sun size={23} aria-hidden="true" /></span><p>Little people.<br />Extraordinary days.</p></div>
  </aside>;
}
