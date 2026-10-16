import {
  parseIbkrEndingCashEur,
  parseIbkrNetDepositsEur,
} from '../src/ibkr'

const csvA = [
  'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount',
  'Deposits & Withdrawals,Data,EUR,2026-06-01,Electronic Fund Transfer,21500',
  'Cash Report,Header,Currency Summary,Currency,Total,Securities',
  'Cash Report,Data,Ending Cash,Base Currency Summary,112.34,112.34',
].join('\n')

const csvB = [
  'Deposits & Withdrawals,Header,Currency,Date,Description,Amount',
  'Deposits & Withdrawals,Data,EUR,2026-06-01,Deposit,20000',
  'Deposits & Withdrawals,Data,EUR,2026-07-01,Deposit,1500',
  'Cash Report,Header,Currency Summary,Currency,Total,Securities',
  'Cash Report,Data,Ending Cash,EUR,50,50',
].join('\n')

const deposits = parseIbkrNetDepositsEur(csvA)
const cash = parseIbkrEndingCashEur(csvA)
if (deposits !== 21500) throw new Error(`deposits ${deposits}`)
if (cash !== 112.34) throw new Error(`cash ${cash}`)
if (parseIbkrNetDepositsEur(csvB) !== 21500) {
  throw new Error(`sum deposits ${parseIbkrNetDepositsEur(csvB)}`)
}
if (parseIbkrEndingCashEur(csvB) !== 50) {
  throw new Error(`cash B ${parseIbkrEndingCashEur(csvB)}`)
}
if (parseIbkrNetDepositsEur('Trades,Header,x\n') != null) {
  throw new Error('expected null without deposits section')
}
console.log({ ok: true, deposits, cash, deployed: deposits! - cash! })
