import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue, notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getDealMetrics from '@salesforce/apex/QuoteDealMetricsController.getDealMetrics';
import runDealMetricsFlow from '@salesforce/apex/QuoteDealMetricsController.runDealMetricsFlow';

import TCV from '@salesforce/schema/Quote.TCV__c';
import YEAR1_MRR from '@salesforce/schema/Quote.Projected_Year1_MRR__c';
import NET_NEW_MRR from '@salesforce/schema/Quote.Net_New_MRR__c';
import BLENDED_ACV from '@salesforce/schema/Quote.Blended_ACV__c';
import DEAL_START from '@salesforce/schema/Quote.Deal_Start_Date__c';
import DEAL_END from '@salesforce/schema/Quote.Deal_End_Date__c';
import TERM_MONTHS from '@salesforce/schema/Quote.Effective_Deal_Term_Months__c';
import LIFECYCLE_TYPE from '@salesforce/schema/Quote.Customer_Lifecycle_Type__c';

// Contract_Term_Months__c and Deal_Type__c are read via Apex to avoid FLS wire errors
const QUOTE_FIELDS = [TCV, YEAR1_MRR, NET_NEW_MRR, BLENDED_ACV, DEAL_START, DEAL_END, TERM_MONTHS, LIFECYCLE_TYPE];

const USD_FORMAT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });


function formatCurrency(value) {
    return value != null ? USD_FORMAT.format(value) : '—';
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    return DATE_FORMAT.format(new Date(Date.UTC(y, m - 1, d)));
}

export default class QuoteDealMetrics extends LightningElement {
    @api recordId;

    isRecalculating = false;
    isExpanded = false;
    _metricsWire;

    @wire(getRecord, { recordId: '$recordId', fields: QUOTE_FIELDS })
    quote;

    @wire(getDealMetrics, { quoteId: '$recordId' })
    wiredMetrics(result) {
        this._metricsWire = result;
    }

    // ── Quote stored-field getters (via getRecord wire) ─────────────────────
    get tcv()          { return getFieldValue(this.quote.data, TCV); }
    get year1Mrr()     { return getFieldValue(this.quote.data, YEAR1_MRR); }
    get netNewMrr()    { return getFieldValue(this.quote.data, NET_NEW_MRR); }
    get blendedAcv()   { return getFieldValue(this.quote.data, BLENDED_ACV); }
    get dealStart()    { return getFieldValue(this.quote.data, DEAL_START); }
    get dealEnd()      { return getFieldValue(this.quote.data, DEAL_END); }
    get termMonths()   { return getFieldValue(this.quote.data, TERM_MONTHS); }
    get lifecycleType(){ return getFieldValue(this.quote.data, LIFECYCLE_TYPE); }

    // ── Derived metrics (via Apex wire — avoids FLS wire restrictions) ───────
    get periods()           { return this._metricsWire?.data?.periods ?? []; }
    get accountCurrentMrr() { return this._metricsWire?.data?.accountCurrentMrr ?? 0; }
    get accountBookedTcv()  { return this._metricsWire?.data?.accountBookedTcv ?? 0; }
    get contractTerm()      { return this._metricsWire?.data?.contractTermMonths ?? null; }
    get oneTimeFees()       { return this._metricsWire?.data?.oneTimeFees ?? 0; }
    get dealType()          { return this._metricsWire?.data?.dealType ?? null; }
    get hasRampPeriods()    { return this.periods.length > 1; }
    get periodsFormatted()  {
        return this.periods.map(p => ({
            name:      p.name,
            startDate: formatDate(p.startDate),
            endDate:   formatDate(p.endDate),
            acv:       formatCurrency(p.acv),
            mrr:       formatCurrency(p.mrr)
        }));
    }
    get showContractTerm()         { return this.contractTerm != null; }
    get contractTermMismatch()     { return this.contractTerm != null && this.contractTerm !== this.termMonths; }
    get contractTermLabelClass()   { return this.contractTermMismatch ? 'field-label term-mismatch' : 'field-label'; }
    get contractTermValueClass()   { return this.contractTermMismatch ? 'field-value term-mismatch' : 'field-value'; }

    // ── Display formatters ──────────────────────────────────────────────────
    get tcvDisplay()              { return formatCurrency(this.tcv); }
    get blendedAcvDisplay()       { return formatCurrency(this.blendedAcv); }
    get year1MrrDisplay()         { return formatCurrency(this.year1Mrr); }
    get netNewMrrDisplay()        { return formatCurrency(this.netNewMrr); }
    get accountCurrentMrrDisplay() { return formatCurrency(this.accountCurrentMrr); }
    get accountBookedTcvDisplay()  { return formatCurrency(this.accountBookedTcv); }
    get oneTimeFeesDisplay()       { return formatCurrency(this.oneTimeFees); }
    get dealStartDisplay()        { return formatDate(this.dealStart); }
    get dealEndDisplay()          { return formatDate(this.dealEnd); }
    get termMonthsDisplay()       { return this.termMonths != null ? `${this.termMonths} months` : '—'; }
    get contractTermDisplay()     { return this.contractTerm != null ? `${this.contractTerm} months` : '—'; }
    get lifecycleTypeDisplay()    { return this.lifecycleType ?? '—'; }
    get dealTypeDisplay()         { return this.dealType ?? '—'; }

    // ── Loading / error state ───────────────────────────────────────────────
    get isLoading()  { return !this.quote.data && !this.quote.error; }
    get hasError()   { return !!this.quote.error || !!this._metricsWire?.error; }
    get errorMessage() {
        const e = this.quote.error || this._metricsWire?.error;
        return e?.body?.message ?? 'An unexpected error occurred.';
    }

    // ── Recalculate handler ─────────────────────────────────────────────────
    handleExpand()   { this.isExpanded = true; }
    handleCollapse() { this.isExpanded = false; }

    handleRecalculate() {
        this.isRecalculating = true;
        runDealMetricsFlow({ quoteId: this.recordId })
            .then(() => {
                notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
                return refreshApex(this._metricsWire);
            })
            .then(() => {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Deal Metrics Updated',
                    message: 'Metrics have been recalculated.',
                    variant: 'success'
                }));
            })
            .catch(error => {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Recalculate Failed',
                    message: error?.body?.message ?? 'Unknown error',
                    variant: 'error',
                    mode: 'sticky'
                }));
            })
            .finally(() => {
                this.isRecalculating = false;
            });
    }
}
