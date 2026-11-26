//+------------------------------------------------------------------+
//| GoldTickScalper.mq5                                              |
//| سكالبينج لحظي على الذهب: يدخل مع زخم التكات، يغلق فور الربح      |
//| أو عند وقف الخسارة أو بعد مهلة قصيرة، ثم يعيد الكرّة.            |
//| جرّبه على حساب تجريبي أولًا.                                     |
//+------------------------------------------------------------------+
#property strict
#property version "1.00"
#include <Trade/Trade.mqh>

input string InpSymbol        = "";      // رمز الذهب (فارغ = رمز الشارت) مثل XAUUSD
input double InpLots          = 0.01;    // حجم الصفقة
input int    InpTicksLookback = 5;       // عدد التكات لقياس الزخم
input int    InpMomentumPts   = 15;      // أقل حركة بالنقاط للدخول
input int    InpTakeProfitPts = 20;      // الربح المستهدف بالنقاط (فوق السبريد)
input int    InpStopLossPts   = 40;      // وقف الخسارة بالنقاط
input int    InpMaxHoldMs     = 800;     // أقصى مدة للصفقة بالمللي ثانية
input int    InpMaxSpreadPts  = 25;      // لا دخول إذا تجاوز السبريد هذا
input int    InpCooldownMs    = 100;     // انتظار بين الصفقات
input int    InpMaxTradesDay  = 300;     // حد الصفقات اليومي
input double InpMaxDailyLoss  = 50.0;    // حد الخسارة اليومي بعملة الحساب
input int    InpSlippagePts   = 10;      // الانزلاق المسموح
input ulong  InpMagic         = 770077;  // الرقم السحري

CTrade trade;
string sym;
double pt;
ulong  lastCloseMs = 0;
ulong  openMs      = 0;
int    tradesToday = 0;
int    dayOfYear   = -1;
double dayStartBalance = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   sym = (InpSymbol == "") ? _Symbol : InpSymbol;
   if(StringFind(sym, "XAU") < 0 && StringFind(sym, "GOLD") < 0)
   {
      Print("هذا البوت للذهب فقط. الرمز الحالي: ", sym);
      return INIT_PARAMETERS_INCORRECT;
   }
   if(!SymbolSelect(sym, true)) return INIT_FAILED;
   pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippagePts);
   trade.SetTypeFillingBySymbol(sym);
   ResetDay();
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void ResetDay()
{
   MqlDateTime t; TimeToStruct(TimeCurrent(), t);
   if(t.day_of_year != dayOfYear)
   {
      dayOfYear = t.day_of_year;
      tradesToday = 0;
      dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   }
}

//+------------------------------------------------------------------+
bool HasPosition(ulong &ticket)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(PositionGetString(POSITION_SYMBOL) == sym &&
         PositionGetInteger(POSITION_MAGIC) == (long)InpMagic)
      { ticket = tk; return true; }
   }
   return false;
}

//+------------------------------------------------------------------+
void ManagePosition(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return;
   long   type  = PositionGetInteger(POSITION_TYPE);
   double open  = PositionGetDouble(POSITION_PRICE_OPEN);
   double bid   = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask   = SymbolInfoDouble(sym, SYMBOL_ASK);
   double pts   = (type == POSITION_TYPE_BUY) ? (bid - open) / pt : (open - ask) / pt;
   ulong  held  = GetTickCount64() - openMs;

   if(pts >= InpTakeProfitPts || pts <= -InpStopLossPts || held >= (ulong)InpMaxHoldMs)
   {
      if(trade.PositionClose(ticket))
         lastCloseMs = GetTickCount64();
      else
         Print("فشل الإغلاق: ", trade.ResultRetcode(), " ", trade.ResultComment());
   }
}

//+------------------------------------------------------------------+
int Momentum()
{
   MqlTick ticks[];
   int n = CopyTicks(sym, ticks, COPY_TICKS_INFO, 0, InpTicksLookback + 1);
   if(n < InpTicksLookback + 1) return 0;
   double first = (ticks[0].bid + ticks[0].ask) / 2.0;
   double last  = (ticks[n-1].bid + ticks[n-1].ask) / 2.0;
   double move  = (last - first) / pt;
   if(move >=  InpMomentumPts) return  1;
   if(move <= -InpMomentumPts) return -1;
   return 0;
}

//+------------------------------------------------------------------+
void OnTick()
{
   ResetDay();

   ulong ticket;
   if(HasPosition(ticket)) { ManagePosition(ticket); return; }

   // حدود الأمان
   if(tradesToday >= InpMaxTradesDay) return;
   if(dayStartBalance - AccountInfoDouble(ACCOUNT_EQUITY) >= InpMaxDailyLoss)
   {
      static bool warned = false;
      if(!warned) { Print("بلغ حد الخسارة اليومي. توقف التداول حتى الغد."); warned = true; }
      return;
   }
   if(GetTickCount64() - lastCloseMs < (ulong)InpCooldownMs) return;
   if(SymbolInfoInteger(sym, SYMBOL_SPREAD) > InpMaxSpreadPts) return;

   int dir = Momentum();
   if(dir == 0) return;

   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   bool ok;
   if(dir > 0) ok = trade.Buy (InpLots, sym, ask, ask - InpStopLossPts * pt * 1.5, 0, "tick-scalp");
   else        ok = trade.Sell(InpLots, sym, bid, bid + InpStopLossPts * pt * 1.5, 0, "tick-scalp");

   if(ok && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED))
   {
      openMs = GetTickCount64();
      tradesToday++;
   }
   else
      Print("فشل الدخول: ", trade.ResultRetcode(), " ", trade.ResultComment());
}
//+------------------------------------------------------------------+
