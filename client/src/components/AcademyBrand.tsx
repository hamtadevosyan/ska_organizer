import logo from '../assets/brand/academy-logo.png';

export default function AcademyBrand() {
  return <span className="academy-brand">
    <span className="academy-brand-logo"><img src={logo} alt="" width="66" height="70" /></span>
    <span>Smart Kids<br />Academy</span>
  </span>;
}
