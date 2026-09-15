// lib/fm-cycle-math.ts
//
// Computes the per-FM cycle report from (a) the FM Orders sheet rows and
// (b) the GHL leads for a dealer. Mirrors the counting rules already used in
// app/api/leads/route.ts so numbers stay consistent:
//   - a lead counts for an FM if it carries that FM's tag
//   - only leads qualified ON/AFTER the order date count as delivered
//   - refund-tagged leads are excluded from delivered, counted as refunds
//
// Remaining formula (confirmed against the mockup):
//   Remaining = New Quota - Prev Balance - Delivered

import type { FmOrderRow } from "./fm-orders-sheet";

const REFUND_TAG = "refund";

// GHL stores dateAdded as UTC; the CRM displays Eastern (UTC-4). Match that.
function easternDate(dateStr: string): Date {
  const edt = new Date(new Date(dateStr).getTime() - 4 * 60 * 60 * 1000);
  return new Date(edt.getUTCFullYear(), edt.getUTCMonth(), edt.getUTCDate());
}

// Minimal shape we need from a lead. The dealer route already produces leads
// with `tags` (lowercased) and `dateQualified`; we accept that shape.
export interface LeadLike {
  tags: string[];
  dateQualified: string;
}

export interface FmCycleResult {
  fm: string;
  fmTag: string;
  cycle: number;
  // Current cycle
  newQuota: number;
  prevBalance: number;
  orderDate: string;
  delivered: number; // on/after orderDate, excluding refunds
  refunds: number; // refund-tagged among this FM's leads since orderDate
  remaining: number; // newQuota - prevBalance - delivered
  // All-time (across every cycle row for this FM)
  allTime: {
    totalOrdered: number; // sum of newQuota across all cycles
    totalDelivered: number; // all this FM's non-refund leads, any date
    totalRefunds: number; // all this FM's refund leads, any date
    cycles: number; // how many cycle rows exist
  };
}

export interface DealerCycleReport {
  dealer: string;
  fms: FmCycleResult[];
  totals: {
    newQuota: number;
    delivered: number;
    refunds: number;
    remaining: number;
  };
}

function leadHasTag(lead: LeadLike, tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return lead.tags.includes(t);
}

/**
 * Builds the cycle report for one dealer.
 * @param dealerRows  all FM Orders sheet rows for this dealer (every cycle)
 * @param leads       this dealer's GHL leads (with lowercased tags)
 */
export function buildDealerCycleReport(
  dealer: string,
  dealerRows: FmOrderRow[],
  leads: LeadLike[]
): DealerCycleReport {
  // Group sheet rows by FM tag so we can compute all-time across cycles.
  const rowsByTag = new Map<string, FmOrderRow[]>();
  for (const r of dealerRows) {
    const key = r.fmTag.trim().toLowerCase();
    const arr = rowsByTag.get(key) ?? [];
    arr.push(r);
    rowsByTag.set(key, arr);
  }

  const fms: FmCycleResult[] = [];

  rowsByTag.forEach((rows, tagKey) => {
    // Active row = the current cycle. If multiple are marked active, take the
    // highest cycle number. If none active, take the highest cycle number.
    const active =
      rows.filter((r) => r.active).sort((a, b) => b.cycle - a.cycle)[0] ||
      rows.slice().sort((a, b) => b.cycle - a.cycle)[0];

    // This FM's leads (any date), split by refund status.
    const fmLeads = leads.filter((l) => leadHasTag(l, tagKey));
    const fmRefundLeads = fmLeads.filter((l) => leadHasTag(l, REFUND_TAG));
    const fmNonRefund = fmLeads.filter((l) => !leadHasTag(l, REFUND_TAG));

    // Current-cycle delivered: non-refund leads on/after the order date.
    const orderStart = active.orderDate ? easternDate(active.orderDate) : null;
    const currentDelivered = orderStart
      ? fmNonRefund.filter(
          (l) => l.dateQualified && easternDate(l.dateQualified) >= orderStart
        ).length
      : fmNonRefund.length;

    // Current-cycle refunds: refund leads on/after the order date.
    const currentRefunds = orderStart
      ? fmRefundLeads.filter(
          (l) => l.dateQualified && easternDate(l.dateQualified) >= orderStart
        ).length
      : fmRefundLeads.length;

    const remaining = active.newQuota - active.prevBalance - currentDelivered;

    const totalOrdered = rows.reduce((sum, r) => sum + r.newQuota, 0);

    fms.push({
      fm: active.fm,
      fmTag: active.fmTag,
      cycle: active.cycle,
      newQuota: active.newQuota,
      prevBalance: active.prevBalance,
      orderDate: active.orderDate,
      delivered: currentDelivered,
      refunds: currentRefunds,
      remaining,
      allTime: {
        totalOrdered,
        totalDelivered: fmNonRefund.length,
        totalRefunds: fmRefundLeads.length,
        cycles: rows.length,
      },
    });
  });

  // Stable display order: by FM name.
  fms.sort((a, b) => a.fm.localeCompare(b.fm));

  const totals = fms.reduce(
    (acc, f) => {
      acc.newQuota += f.newQuota;
      acc.delivered += f.delivered;
      acc.refunds += f.refunds;
      acc.remaining += f.remaining;
      return acc;
    },
    { newQuota: 0, delivered: 0, refunds: 0, remaining: 0 }
  );

  return { dealer, fms, totals };
}
