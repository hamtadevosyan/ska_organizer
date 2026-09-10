export function currentMonday() {
  const date = new Date();
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
