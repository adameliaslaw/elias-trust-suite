// Timecard CSV import (built for Dripos exports, tolerant of others).
// Ported from the firm payroll app (payroll/timecards.py).
//
// Dripos has no public developer API; its Time Card report exports
// shift-level rows (employee, clock-in/out, total hours, tips). This module
// parses such a CSV with flexible header matching, aggregates shifts per
// employee, and computes weekly overtime: hours beyond 40 in a calendar
// week (Sunday-Saturday), which is the FLSA/NJ rule for non-exempt hourly
// staff.
//
// If the export has no date column, overtime cannot be derived and all
// hours are returned as regular — the caller flags that for manual review.
// If the export has its own overtime column, that is trusted as-is.
const { cents } = require('./engine');

// Header aliases, matched case-insensitively after stripping non-letters.
const HEADER_ALIASES = {
  email: ['email', 'employeeemail', 'workemail'],
  name: ['employee', 'employeename', 'name', 'teammember', 'staff'],
  firstName: ['firstname', 'first'],
  lastName: ['lastname', 'last'],
  hours: ['totalhours', 'hours', 'regularhours', 'hoursworked', 'paidhours'],
  otHours: ['overtimehours', 'overtime', 'othours', 'ot'],
  tips: ['tips', 'tippayout', 'cardtips', 'totaltips', 'tipsearned', 'tipamount'],
  date: ['date', 'shiftdate', 'clockin', 'clockindate', 'day', 'start', 'starttime']
};

const WEEKLY_OT_THRESHOLD = 40;

function norm(header) {
  return String(header || '').toLowerCase().replace(/[^a-z]/g, '');
}

function mapHeaders(fieldnames) {
  const mapping = {};
  for (const field of fieldnames || []) {
    const n = norm(field);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (!(key in mapping) && aliases.includes(n)) mapping[key] = field;
    }
  }
  return mapping;
}

function num(value) {
  const cleaned = String(value || '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

// RFC-4180-ish CSV split (quoted fields, embedded commas/quotes).
function splitCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseDateCell(value) {
  const text = String(value || '').trim();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO (optionally with time)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);        // US m/d/y (optionally with time)
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = text.match(/^([A-Za-z]{3,9}) (\d{1,2}), (\d{4})$/);    // "Jul 6, 2026"
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mo = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

// Sunday-starting week key, date-arithmetic in UTC to avoid TZ traps.
function weekKey(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());   // getUTCDay: Sun=0
  return dt.toISOString().slice(0, 10);
}

// Parse a timecard CSV. Returns { rows, info } where rows is a list of
// per-employee objects { email, name, hours, otHours, tips } and info
// describes what was detected (for the import summary).
function parseTimecards(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
  if (!lines.length) throw new Error('The file is empty');
  const fieldnames = splitCSVLine(lines[0]).map(h => h.trim());
  const mapping = mapHeaders(fieldnames);
  if (!('hours' in mapping) && !('tips' in mapping)) {
    throw new Error('Could not find an hours or tips column. Headers seen: ' + fieldnames.join(', '));
  }
  if (!('email' in mapping) && !('name' in mapping) && !('firstName' in mapping && 'lastName' in mapping)) {
    throw new Error('Could not find an employee name or email column.');
  }
  const col = key => fieldnames.indexOf(mapping[key]);
  const hasOtColumn = 'otHours' in mapping;
  const hasDate = 'date' in mapping;

  const people = new Map();
  for (const line of lines.slice(1)) {
    const cells = splitCSVLine(line);
    const cell = key => (key in mapping ? (cells[col(key)] || '') : '');
    const email = cell('email').trim().toLowerCase();
    let name = '';
    if ('name' in mapping) name = cell('name').trim();
    else if ('firstName' in mapping && 'lastName' in mapping) {
      name = `${cell('firstName').trim()} ${cell('lastName').trim()}`.trim();
    }
    if (!email && !name) continue;
    const key = email || name.toLowerCase();
    if (!people.has(key)) {
      people.set(key, { email, name, hours: 0, otHours: 0, tips: 0, weekHours: new Map() });
    }
    const person = people.get(key);
    const hours = 'hours' in mapping ? num(cell('hours')) : 0;
    person.tips += 'tips' in mapping ? num(cell('tips')) : 0;
    if (hasOtColumn) {
      person.hours += hours;
      person.otHours += num(cell('otHours'));
    } else if (hasDate) {
      const shiftDate = parseDateCell(cell('date'));
      if (shiftDate) {
        const wk = weekKey(shiftDate);
        person.weekHours.set(wk, (person.weekHours.get(wk) || 0) + hours);
      } else {
        person.hours += hours;   // unparseable date: treat as regular
      }
    } else {
      person.hours += hours;
    }
  }

  let otComputed = false;
  for (const person of people.values()) {
    for (const weekTotal of person.weekHours.values()) {
      const ot = Math.max(weekTotal - WEEKLY_OT_THRESHOLD, 0);
      person.otHours += ot;
      person.hours += weekTotal - ot;
      if (ot > 0) otComputed = true;
    }
    delete person.weekHours;
    person.hours = cents(person.hours);
    person.otHours = cents(person.otHours);
    person.tips = cents(person.tips);
  }

  const info = {
    detected: Object.keys(mapping).sort(),
    otSource: hasOtColumn ? 'column'
      : hasDate ? 'computed weekly (>40h, Sun-Sat)'
      : 'none — review overtime manually',
    otComputed: otComputed || hasOtColumn
  };
  return { rows: [...people.values()], info };
}

// Match a parsed row to an employee record: email first, then name
// (forward or reversed, punctuation-insensitive, so "Smith, Bob" works).
function matchEmployee(person, employees) {
  if (person.email) {
    const byEmail = employees.find(e => String(e.email || '').trim().toLowerCase() === person.email);
    if (byEmail) return byEmail;
  }
  const target = norm(person.name);
  if (!target) return null;
  return employees.find(e => {
    const forward = norm(`${e.firstName}${e.lastName}`);
    const backward = norm(`${e.lastName}${e.firstName}`);
    return target === forward || target === backward;
  }) || null;
}

module.exports = { WEEKLY_OT_THRESHOLD, parseTimecards, matchEmployee, parseDateCell, weekKey };
