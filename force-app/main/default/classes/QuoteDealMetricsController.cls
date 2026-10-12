public with sharing class QuoteDealMetricsController {

    public class PeriodRow {
        @AuraEnabled public String name;
        @AuraEnabled public Date startDate;
        @AuraEnabled public Date endDate;
        @AuraEnabled public Decimal acv;
        @AuraEnabled public Decimal mrr;
    }

    public class DealMetricsResult {
        @AuraEnabled public List<PeriodRow> periods;
        @AuraEnabled public Decimal accountCurrentMrr;
        @AuraEnabled public Decimal accountBookedTcv;
        @AuraEnabled public Decimal contractTermMonths;
        @AuraEnabled public Decimal oneTimeFees;
        @AuraEnabled public String dealType;
    }

    @AuraEnabled(cacheable=true)
    public static DealMetricsResult getDealMetrics(String quoteId) {
        DealMetricsResult result = new DealMetricsResult();
        result.periods = new List<PeriodRow>();
        result.accountCurrentMrr = 0;
        result.accountBookedTcv = 0;

        Quote q = [SELECT Id, AccountId, ContractId, One_Time_Non_Recurring_Fees__c, Deal_Type__c FROM Quote WHERE Id = :quoteId LIMIT 1];
        result.dealType = q.Deal_Type__c;
        result.oneTimeFees = q.One_Time_Non_Recurring_Fees__c;
        if (q.ContractId != null) {
            List<Contract> contracts = [SELECT ContractTerm FROM Contract WHERE Id = :q.ContractId LIMIT 1];
            if (!contracts.isEmpty() && contracts[0].ContractTerm != null) {
                result.contractTermMonths = Decimal.valueOf(contracts[0].ContractTerm);
            }
        }

        // Subscription-only QLI totals per QLG (EndDate != null = term subscription, excludes one-time PSM lines)
        Map<Id, Decimal> qlgSubTotals = new Map<Id, Decimal>();
        for (AggregateResult ar : (List<AggregateResult>) Database.query(
            'SELECT QuoteLineGroupId qlgId, SUM(TotalPrice) total ' +
            'FROM QuoteLineItem ' +
            'WHERE QuoteId = :quoteId AND QuoteLineGroupId != null AND EndDate != null ' +
            'GROUP BY QuoteLineGroupId'
        )) {
            Id gId = (Id) ar.get('qlgId');
            Decimal tot = (Decimal) ar.get('total');
            qlgSubTotals.put(gId, tot != null ? tot : 0);
        }

        // Dynamic SOQL: StartDate/EndDate compile-time schema check fails in this API version
        // but the fields exist at runtime (RLM Revenue Cloud fields).
        for (SObject qlg : Database.query(
            'SELECT Id, Name, StartDate, EndDate ' +
            'FROM QuoteLineGroup ' +
            'WHERE QuoteId = :quoteId AND IsRamped = true ' +
            'ORDER BY StartDate ASC NULLS LAST'
        )) {
            PeriodRow row = new PeriodRow();
            row.name      = (String) qlg.get('Name');
            row.startDate = (Date)   qlg.get('StartDate');
            row.endDate   = (Date)   qlg.get('EndDate');
            Id gId        = (Id)     qlg.get('Id');
            row.acv       = qlgSubTotals.containsKey(gId) ? qlgSubTotals.get(gId) : 0;
            row.mrr       = row.acv / 12;
            result.periods.add(row);
        }

        Id accountId = q.AccountId;
        if (accountId == null) {
            List<QuoteAction> qas = [SELECT SourceAssetId FROM QuoteAction WHERE QuoteId = :quoteId AND SourceAssetId != null LIMIT 1];
            if (!qas.isEmpty()) {
                List<Asset> sourceAssets = [SELECT AccountId FROM Asset WHERE Id = :qas[0].SourceAssetId LIMIT 1];
                if (!sourceAssets.isEmpty()) {
                    accountId = sourceAssets[0].AccountId;
                }
            }
        }
        AggregateResult[] mrrAgg = [
            SELECT SUM(CurrentMrr) totalMrr
            FROM Asset
            WHERE AccountId = :accountId
        ];
        if (!mrrAgg.isEmpty() && mrrAgg[0].get('totalMrr') != null) {
            result.accountCurrentMrr = (Decimal) mrrAgg[0].get('totalMrr');
        }

        // Sum Mrr × months across all current/future AssetStatePeriods for the account.
        // StartDate/EndDate are Datetime on AssetStatePeriod; use dynamic SOQL to avoid compile-time schema errors.
        for (SObject asp : Database.query(
            'SELECT Mrr, StartDate, EndDate FROM AssetStatePeriod ' +
            'WHERE Asset.AccountId = :accountId AND EndDate >= TODAY ' +
            'ORDER BY StartDate ASC'
        )) {
            Decimal mrr = (Decimal) asp.get('Mrr');
            if (mrr == null || mrr == 0) continue;
            Datetime startDt = (Datetime) asp.get('StartDate');
            Datetime endDt   = (Datetime) asp.get('EndDate');
            Date startD = startDt.date();
            Date endD   = endDt.date();
            Integer months = (endD.year() - startD.year()) * 12 + (endD.month() - startD.month());
            if (months <= 0) months = 1;
            result.accountBookedTcv += mrr * months;
        }

        return result;
    }

    @AuraEnabled
    public static void runDealMetricsFlow(String quoteId) {
        Map<String, Object> params = new Map<String, Object>{ 'quoteId' => quoteId };
        Flow.Interview.RLM_Quote_Deal_Metrics interview = new Flow.Interview.RLM_Quote_Deal_Metrics(params);
        interview.start();
    }
}
