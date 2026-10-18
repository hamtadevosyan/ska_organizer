# Proposed staff access and badge clock

Status: proposal for follow-up work, including SKAO-106. SKAO-111 implements only the assigned **Class viewer** preset.

Keep an employee record, a job title, an application account and a clock credential separate. A cleaner may need a clock credential without access to children or planning. An employee can exist without an application sign-in. An account's class scope must be explicitly assigned rather than inferred from names or job titles.

| Proposed preset | Read scope | Allowed changes |
|---|---|---|
| Administrator | Authorized facility administration | Accounts and authorized operational administration |
| Editor | Authorized facility operations | Operational editing; sensitive employee/document access remains separately controlled |
| Class viewer (implemented) | One assigned active class's minimal overview, names, saved activities and shared meal names | Own password/session only |
| Facility viewer | Explicitly approved facility operational information | Own password/session only; no generation or draft mutation |
| Time clock only | Own current clock state and approved personal time history | Own clock in/out only |

Facility-wide reading must not automatically include contracts, medical records, employee files, payroll or tax information. Design separate permissions and minimal response projections for those areas. Class assignment should not be required for office or support staff.

## Proposed badge operation

Use a dedicated local clock station connected to the local server. The employee taps a revocable badge, optionally enters a personal PIN, and confirms **Clock in** or **Clock out**. Show confirmation and return to the neutral screen without exposing the roster. Record employee, server timestamp, event and station. Avoid relying on the tablet's date or an employee-supplied timestamp.

A static QR code or basic NFC identifier can be copied or lent; possession alone does not prove who worked. If stronger assurance is required, use a reader and badges that support cryptographic authentication, with a PIN as appropriate. Select hardware only after verifying local integration and operating-system compatibility. Keep the first implementation independent of a particular Pi or VM.

Lost badges must be revoked immediately and replaced without changing the employee record. Rate-limit PIN attempts and authorize each registered station narrowly. Clock credentials must not sign into the administrative application. A network outage should show a clear failure unless an explicitly designed, tamper-evident offline queue is implemented and tested.

Store original punches and a separate correction/approval history. Payroll uses approved time and the employee's effective hourly rate; clock-in access does not expose rate, tax or other employees' data. Address pay rules, approvals and reporting in the payroll/timekeeping story before using calculated amounts for actual payroll.
