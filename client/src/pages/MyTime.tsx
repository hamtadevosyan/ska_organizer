import { Link } from 'react-router-dom';
import { useAuth } from '../auth/context';
import './payroll.css';

export default function MyTime() {
  const { account } = useAuth();
  const manager = account?.role === 'admin' || account?.role === 'editor';
  return <div className="payroll-page ska-core-page"><header><h1>Staff check-in has moved</h1><p>Use the academy clock station, or ask an administrator or editor to record your arrival or departure.</p></header>
    <section><Link to={manager ? '/staff/clock' : '/classroom'}>{manager ? 'Open staff clock' : 'Back to my class'}</Link></section>
  </div>;
}
