import { Injectable } from '@nestjs/common';
import type { InventoryValuationMethod } from '@procureflow/shared';
import Decimal from 'decimal.js';

export interface StockBalance {
  qty: Decimal;
  value: Decimal;
}

export interface FifoLayer {
  qty: Decimal;
  unitCost: Decimal;
}

export interface LandedCostComponents {
  unitPrice: Decimal.Value;
  freightPerUnit?: Decimal.Value;
  importDutyPerUnit?: Decimal.Value;
  clearancePerUnit?: Decimal.Value;
}

/**
 * InventoryValuationService (Slice 5). Pure valuation math for the stock ledger
 * (ADR-014 — ledger, not a WMS). Weighted-average is the seeded default; FIFO is
 * layer-based. All arithmetic through decimal.js (Master Context §3 rule #4).
 */
@Injectable()
export class InventoryValuationService {
  /** Unit landed cost = unit price + freight + import duty + clearance. */
  computeLandedCost(components: LandedCostComponents): Decimal {
    return new Decimal(components.unitPrice)
      .plus(components.freightPerUnit ?? 0)
      .plus(components.importDutyPerUnit ?? 0)
      .plus(components.clearancePerUnit ?? 0);
  }

  /**
   * Next balance after a movement. `delta` is signed (+receipt, -issue/reversal).
   * On weighted-average, issues leave the average cost unchanged and reduce value
   * at that average; receipts recompute the average. Balance floors at zero qty.
   */
  updateBalance(
    prev: StockBalance,
    delta: Decimal.Value,
    unitCost: Decimal.Value,
    // Weighted-average is applied here; FIFO callers use `updateFifo` (ADR-014).
    _method: InventoryValuationMethod,
  ): StockBalance {
    const d = new Decimal(delta);
    const cost = new Decimal(unitCost);

    if (d.greaterThanOrEqualTo(0)) {
      const qty = prev.qty.plus(d);
      const value = prev.value.plus(d.times(cost));
      return { qty, value: this.clampValue(qty, value) };
    }

    // Issue / reversal: reduce at the current weighted-average cost.
    const avg = prev.qty.isZero() ? cost : prev.value.dividedBy(prev.qty);
    const qty = prev.qty.plus(d); // d is negative
    if (qty.lessThanOrEqualTo(0)) return { qty: new Decimal(0), value: new Decimal(0) };
    return { qty, value: qty.times(avg) };
  }

  /** Weighted-average unit cost of a balance (0 when empty). */
  averageCost(balance: StockBalance): Decimal {
    return balance.qty.isZero() ? new Decimal(0) : balance.value.dividedBy(balance.qty);
  }

  /**
   * FIFO update over cost layers. Positive delta appends a layer; negative
   * consumes from the oldest layers first. Returns the new layer stack.
   */
  updateFifo(
    layers: FifoLayer[],
    delta: Decimal.Value,
    unitCost: Decimal.Value,
  ): FifoLayer[] {
    const d = new Decimal(delta);
    if (d.greaterThan(0)) {
      return [...layers, { qty: d, unitCost: new Decimal(unitCost) }];
    }
    let toConsume = d.abs();
    const out: FifoLayer[] = layers.map((l) => ({ qty: l.qty, unitCost: l.unitCost }));
    let i = 0;
    while (toConsume.greaterThan(0) && i < out.length) {
      const layer = out[i]!;
      if (layer.qty.lessThanOrEqualTo(toConsume)) {
        toConsume = toConsume.minus(layer.qty);
        layer.qty = new Decimal(0);
        i += 1;
      } else {
        layer.qty = layer.qty.minus(toConsume);
        toConsume = new Decimal(0);
      }
    }
    return out.filter((l) => l.qty.greaterThan(0));
  }

  /** Collapse FIFO layers to a single balance. */
  fifoBalance(layers: FifoLayer[]): StockBalance {
    const qty = layers.reduce((a, l) => a.plus(l.qty), new Decimal(0));
    const value = layers.reduce(
      (a, l) => a.plus(l.qty.times(l.unitCost)),
      new Decimal(0),
    );
    return { qty, value };
  }

  private clampValue(qty: Decimal, value: Decimal): Decimal {
    return qty.isZero() ? new Decimal(0) : value;
  }
}
