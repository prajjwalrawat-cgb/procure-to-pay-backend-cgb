import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { InventoryValuationService } from './inventory-valuation.service';

const svc = new InventoryValuationService();
const bal = (qty: string, value: string) => ({
  qty: new Decimal(qty),
  value: new Decimal(value),
});

describe('InventoryValuationService.computeLandedCost', () => {
  it('sums unit price + freight + duty + clearance', () => {
    const c = svc.computeLandedCost({
      unitPrice: '128500',
      freightPerUnit: '1500',
      importDutyPerUnit: '0',
      clearancePerUnit: '250',
    });
    expect(c.toFixed(2)).toBe('130250.00');
  });

  it('defaults optional components to zero', () => {
    expect(svc.computeLandedCost({ unitPrice: '100' }).toFixed(2)).toBe('100.00');
  });
});

describe('InventoryValuationService.updateBalance (weighted average)', () => {
  it('first receipt sets balance and value', () => {
    const next = svc.updateBalance(bal('0', '0'), '7.6', '128500', 'WEIGHTED_AVERAGE');
    expect(next.qty.toFixed(4)).toBe('7.6000');
    expect(next.value.toFixed(2)).toBe('976600.00');
  });

  it('second receipt at a different cost recomputes weighted average', () => {
    const first = svc.updateBalance(bal('0', '0'), '10', '100', 'WEIGHTED_AVERAGE');
    const second = svc.updateBalance(first, '10', '120', 'WEIGHTED_AVERAGE');
    expect(second.qty.toFixed(0)).toBe('20');
    expect(second.value.toFixed(0)).toBe('2200'); // 1000 + 1200
    expect(svc.averageCost(second).toFixed(0)).toBe('110');
  });

  it('issue reduces value at the weighted-average cost', () => {
    const start = bal('20', '2200'); // avg 110
    const issued = svc.updateBalance(start, '-5', '0', 'WEIGHTED_AVERAGE');
    expect(issued.qty.toFixed(0)).toBe('15');
    expect(issued.value.toFixed(0)).toBe('1650'); // 15 * 110
  });

  it('full RMA reversal drives the balance to zero', () => {
    const received = svc.updateBalance(
      bal('0', '0'),
      '7.8',
      '128500',
      'WEIGHTED_AVERAGE',
    );
    const reversed = svc.updateBalance(received, '-7.8', '128500', 'WEIGHTED_AVERAGE');
    expect(reversed.qty.toFixed(4)).toBe('0.0000');
    expect(reversed.value.toFixed(4)).toBe('0.0000');
  });
});

describe('InventoryValuationService FIFO', () => {
  it('consumes oldest layers first', () => {
    let layers = svc.updateFifo([], '10', '100');
    layers = svc.updateFifo(layers, '10', '120');
    layers = svc.updateFifo(layers, '-15', '0');
    const b = svc.fifoBalance(layers);
    expect(b.qty.toFixed(0)).toBe('5'); // 15 consumed from the two layers
    expect(b.value.toFixed(0)).toBe('600'); // remaining 5 @ 120
  });

  it('full reversal empties the FIFO stack', () => {
    let layers = svc.updateFifo([], '7.8', '128500');
    layers = svc.updateFifo(layers, '-7.8', '0');
    expect(svc.fifoBalance(layers).qty.toFixed(4)).toBe('0.0000');
  });
});
