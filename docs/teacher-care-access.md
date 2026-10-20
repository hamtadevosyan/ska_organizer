# Teacher attendance and safety cards (SKAO-111)

The **Teacher** role extends assigned-class access with current attendance and essential health and emergency information. It is separate from **Class viewer**, which remains read-only and cannot see clinical details. Existing viewers are never promoted automatically.

| Capability | Class viewer | Teacher | Editor | Administrator |
|---|---|---|---|---|
| Basic children names and saved class plans | Assigned class | Assigned class | Existing operational access | Existing operational access |
| Essential safety card | No | Active children in assigned active class | Read | Read and maintain |
| Record actual arrival/departure | No | Assigned active class, today only | Existing attendance access | Existing attendance access |
| Attendance corrections/history editing | No | No | Existing audited corrections | Existing audited corrections |
| Registration contracts and uploaded medical files | No | No | Existing restrictions remain | Existing authorized document access |
| Accounts and class assignments | No | No | No | Yes |

## Set up a teacher

As administrator, open Accounts, choose Teacher and assign an active class. No class assigned is permitted but reveals no class records. Display names and employee job titles do not infer permissions. Class or role changes revoke all sessions for that account, including remembered sessions. Substitute teachers can be explicitly assigned their current class and reassigned when coverage ends.

On a phone, teachers get Attendance in the bottom navigation. Children is available under More. Desktop navigation contains Class attendance and Children. Old links to global management pages redirect before those pages mount or fetch data. Legacy operational APIs remain forbidden to Teacher accounts, including generation, inventory, staff and documentation APIs.

## Maintain a safety card

Open Children, View profile, then Health & emergency. Administrators can select Edit safety card, enter the current information and confirm that it was reviewed against parent and medical instructions before saving. Editors can read the card but cannot edit it.

The structured card contains allergy status/details, dietary restrictions, actionable medical alerts, emergency care instructions, approved medication instructions/location, physician contact, emergency contacts, authorized pickup people, pickup restrictions and emergency-treatment-consent status. It shows the last review time. Phone links allow the authorized user to initiate a call.

Unknown information stays **unknown**. A missing card never means there are no allergies. Nothing is inferred from operational notes, registration PDFs, image OCR or an AI model. The card is a reviewed summary; it does not grant medication-administration authority or authorize a release by itself. Maintain the facility's current approved care plans and emergency procedures.

The card has optimistic version checks. Concurrent edits return a conflict without overwriting the other administrator's changes. A connection outage hides current safety details while preserving an administrator's unsaved draft in memory. After recovery the draft retains its original version so it cannot overwrite a newer review unnoticed. Cancel and refresh to reconcile a conflict.

## Attendance boundaries

Teachers can record today's arrivals and departures for active children assigned to their active class. The server determines time, class and acting account. Check-in retries reuse an identifier; replaying a successful action does not create a duplicate visit or duplicate audit event. Checkout uses the visit version. Older open visits, invalid times, duplicates, moved children and corrections need administrator/editor review.

These actions record staff observations. They do not represent the authorized adult's signature. Keep the required adult sign-in/sign-out process separately; [CDSS Title 22 §101229.1](https://www.cdss.ca.gov/ord/entres/getinfo/pdf/ccc5.pdf) describes the signature and time requirements. This update does not implement electronic parent signatures.

## Server contracts and privacy

| Endpoint | Permission |
|---|---|
| `GET /api/classroom/attendance` | Teacher; today's minimal assigned-class roster/visits |
| `POST /api/classroom/children/:childId/checkin` | Teacher; `{date,requestId}` only |
| `POST /api/classroom/attendance/:id/checkout` | Teacher; `{date,version}` only |
| `GET /api/classroom/children/:childId/safety` | Teacher; active assigned child only |
| `GET /api/children/:childId/safety` | Administrator/editor |
| `PUT /api/children/:childId/safety` | Administrator; complete reviewed details plus `version` and `reviewed:true` |

Queries cannot select another class or include private documents. Attendance responses contain only visit ID, times, version, void/review state and permitted actions. Safety reads and writes audit the actor and child ID, without putting clinical content, contacts or payloads in audit records. Writes and their audit event commit together; an audit failure rolls back the write. Fresh session, role, room and child checks run under authentication then room locks. Mutations require the normal exact Origin and CSRF token.

Safety is stored separately in `ChildSafetyProfiles`, not appended to ordinary child lists or profile responses. Teacher/Class viewer rosters do not carry clinical fields. API responses remain no-store, and the static-only service worker does not cache them. Teacher screens discard old data on scope changes, failed refreshes and outages; late responses cannot restore the previous class.

Migration `025-teacher-care-access` adds Teacher to the role constraints and allows its explicit class assignment, then creates the safety table with child/reviewer foreign keys and a positive version constraint. Existing accounts, password hashes, viewer roles, sessions, children and attendance remain intact. Migration 024 still performs its documented one-time viewer logout if that earlier migration has not yet run. Repeating migration 025 is a no-op.

## Verify and remaining scope

Run `bash scripts/check-update.sh --access`, then the full update check before merging. The focused command retains backup and migration steps and includes Teacher API, native PostgreSQL, component, routing, browser, static PWA and production-build clinical privacy scenarios. Test two synthetic classes, a Teacher, a Class viewer, an editor and an administrator. Verify card review, retries, direct foreign-child denial, reassignment/logout and phone layout.

An audited emergency override for another class, simultaneous multi-class coverage, a generated facility emergency-backup packet and parent electronic signatures are not implemented here. Keep an approved protected physical emergency backup available for server or power outages. Badge timekeeping and payroll remain separate work.
