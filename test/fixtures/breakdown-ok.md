# EPIC: Add partner contacts

Give each partner unit a named contact and phone number.

## TASK: Add contact columns to the schema

**Estimate:** 2
**Depends on:** none
**Description:** Add contact_name and contact_phone to the units table.
**Acceptance criteria:**
- Migration applies cleanly

## TASK: Show the contact on the unit page

**Estimate:** 3
**Depends on:** Add contact columns to the schema
**Description:** Render the contact under the unit header.
**Acceptance criteria:**
- Name and phone render when present
