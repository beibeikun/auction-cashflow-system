import { createApp } from "vue";

const money = new Intl.NumberFormat("ja-JP");

createApp({
  data() {
    return {
      state: null,
      activeTab: localStorage.getItem("auction.activeTab") || "record",
      editingLotId: "",
      editingCustomerId: "",
      editingCustomerBookId: "",
      settlementCustomer: "",
      settlementSellerScope: "all",
      settlementFilters: {
        excludeBuyer: false,
        excludeSeller: false,
        excludeReturns: false,
        onlyReturns: false,
        showAll: false,
        ignoreStatusAmount: false
      },
      filterText: "",
      dealPlateFilter: "",
      dealSortOrder: localStorage.getItem("auction.dealSortOrder") || "desc",
      selectedLots: new Set(),
      live: false,
      isDashboardFullscreen: false,
      now: new Date(),
      clockTimer: null,
      liveEntryDirty: false,
      liveEntrySyncTimer: null,
      entry: this.blankEntry(),
      customerForm: this.blankCustomer(),
      customerBookForm: this.blankCustomerBook(),
      customerSaveError: "",
      customerBookSaveError: "",
      customerBookFilter: "",
      csvFile: null,
      csvCustomersOnly: false,
      importMessage: "",
      showSettlementPreview: false,
      entrySaveError: "",
      quickItemName: "",
      quickItemMessage: "",
      itemCodeDraft: "",
      sellerCodeDraft: "",
      newSessionName: "",
      sessionMessage: "",
      companyProfileMessage: ""
    };
  },
  computed: {
    tabs() {
      return [
        ["screen", "数据大屏", "▣"],
        ["record", "现场录入", "⌁"],
        ["deals", "成交登记", "☷"],
        ["settlement", "精算结算", "∑"],
        ["customers", "客户资料", "◇"],
        ["settings", "场次设置", "⚙"],
        ["export", "完整明细", "⇩"]
      ];
    },
    sessions() {
      return this.state?.sessions || [];
    },
    activeSession() {
      return this.sessions.find((session) => session.id === this.state?.activeSessionId) || {};
    },
    companyProfile() {
      return this.state?.companyProfile || this.blankCompanyProfile();
    },
    companyPostalLine() {
      return this.companyProfile.postalCode ? `〒${this.companyProfile.postalCode}` : "";
    },
    companyAddressLines() {
      return String(this.companyProfile.address || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    },
    lots() {
      return this.state ? this.state.lots.map((lot) => this.deriveLot(lot)) : [];
    },
    sortedLots() {
      return [...this.lots].sort((a, b) => Number(a.itemNo) - Number(b.itemNo));
    },
    dealPlateOptions() {
      const options = [];
      const seenCustomers = new Set();
      const seenSellerLabels = new Set();
      for (const customer of this.customers) {
        if (customer.bidderNo !== "" && !seenCustomers.has(String(customer.bidderNo))) {
          seenCustomers.add(String(customer.bidderNo));
          options.push({ value: `customer:${customer.bidderNo}`, label: `${customer.bidderNo} · ${this.customerDisplayName(customer) || "未命名"}` });
        }
        if (customer.sellerLabel && !seenSellerLabels.has(customer.sellerLabel)) {
          seenSellerLabels.add(customer.sellerLabel);
          options.push({ value: `seller:${customer.sellerLabel}`, label: `${customer.sellerLabel} · 出货号牌` });
        }
      }
      return options;
    },
    dealRows() {
      const words = this.filterText.trim().toLowerCase();
      return this.lots
        .filter((row) => this.matchesDealPlate(row))
        .filter((row) => !words || JSON.stringify(row).toLowerCase().includes(words))
        .sort((a, b) => (this.dealSortOrder === "asc" ? Number(a.itemNo) - Number(b.itemNo) : Number(b.itemNo) - Number(a.itemNo)));
    },
    recentRows() {
      return [...this.lots].sort((a, b) => Number(b.itemNo) - Number(a.itemNo)).slice(0, 12);
    },
    completedRows() {
      return this.lots.filter((row) => row.buyerNo !== "" && row.buyerNo !== -1 && row.amount > 0);
    },
    screenLot() {
      const liveEntry = this.state?.liveEntry || {};
      if (liveEntry.live) return this.deriveLot(liveEntry);
      const draft = this.entryPreview;
      const hasDraft = this.liveEntryDirty && [draft.sellerCode, draft.itemCode, draft.buyerNo, draft.priceK, draft.note].some((value) => String(value ?? "").trim() !== "");
      return hasDraft ? draft : this.recentRows[0] || draft;
    },
    dashboardStats() {
      const sold = this.completedRows;
      const totalAmount = sold.reduce((sum, row) => sum + row.amount, 0);
      const sellerCommission = sold.reduce((sum, row) => sum + row.sellerCommission, 0);
      const buyerCommission = sold.reduce((sum, row) => sum + row.buyerCommission, 0);
      const sellerTax = sold.reduce((sum, row) => sum + row.sellerTax, 0);
      const buyerTax = sold.reduce((sum, row) => sum + row.buyerTax, 0);
      const highest = [...sold].sort((a, b) => b.amount - a.amount)[0] || {};
      return {
        lotCount: this.lots.length,
        soldCount: sold.length,
        pendingCount: this.lots.filter((row) => row.buyerNo === "").length,
        returnCount: this.lots.filter((row) => this.isSettlementReturn(row)).length,
        totalAmount,
        sellerCommission,
        buyerCommission,
        totalCommission: sellerCommission + buyerCommission,
        taxTotal: sellerTax + buyerTax,
        buyerReceivable: sold.reduce((sum, row) => sum + row.buyerTotal, 0),
        sellerPayable: sold.reduce((sum, row) => sum + row.sellerNet, 0),
        averageAmount: sold.length ? totalAmount / sold.length : 0,
        highestAmount: highest.amount || 0,
        highestLabel: highest.itemName || highest.itemCode || "-"
      };
    },
    statusBreakdown() {
      const total = Math.max(this.lots.length, 1);
      const rows = [
        ["成交", this.completedRows.length],
        ["待拍", this.lots.filter((row) => row.buyerNo === "").length],
        ["退回", this.lots.filter((row) => this.isSettlementReturn(row)).length],
        ["异常", this.lots.filter((row) => row.status === "结算异常！").length]
      ];
      return rows.map(([label, count]) => ({ label, count, percent: Math.round(count / total * 100) }));
    },
    recentSoldRows() {
      return [...this.completedRows]
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0) || Number(b.itemNo) - Number(a.itemNo))
        .slice(0, 8);
    },
    topBidRows() {
      const highest = Math.max(...this.completedRows.map((row) => row.amount), 1);
      return [...this.completedRows]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
        .map((row) => ({ ...row, percent: Math.max(6, Math.round(row.amount / highest * 100)) }));
    },
    sellerRankRows() {
      const groups = new Map();
      for (const row of this.completedRows) {
        const key = row.sellerLabel || row.sellerCode || "未匹配";
        if (!groups.has(key)) groups.set(key, { key, name: row.sellerName || "", amount: 0, count: 0 });
        const group = groups.get(key);
        group.amount += row.amount;
        group.count += 1;
      }
      const rows = [...groups.values()].sort((a, b) => b.amount - a.amount).slice(0, 5);
      const max = Math.max(...rows.map((row) => row.amount), 1);
      return rows.map((row) => ({ ...row, percent: Math.max(6, Math.round(row.amount / max * 100)) }));
    },
    dashboardClock() {
      return this.now.toLocaleTimeString("zh-CN", { hour12: false });
    },
    stats() {
      return {
        count: this.lots.length,
        totalAmount: this.lots.reduce((sum, row) => sum + row.amount, 0),
        toReceive: this.lots.filter((row) => row.buyerAction === "可收").length,
        toPay: this.lots.filter((row) => row.sellerAction === "可付").length,
        bad: this.lots.filter((row) => row.status === "结算异常！").length
      };
    },
    customers() {
      return [...(this.state?.customers || [])].sort((a, b) => Number(a.bidderNo) - Number(b.bidderNo));
    },
    customerBook() {
      return [...(this.state?.customerBook || [])].sort((a, b) => (a.actualName || "").localeCompare(b.actualName || "", "zh-Hans-CN"));
    },
    filteredCustomerBook() {
      const words = this.customerBookFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return this.customerBook;
      return this.customerBook.filter((book) => {
        const text = [book.id, book.actualName, book.phone, book.address, book.antiqueLicenseNo].join(" ").toLowerCase();
        return words.every((word) => text.includes(word));
      });
    },
    registeredCustomerRows() {
      return this.customers.map((customer) => ({
        ...customer,
        book: this.customerBookEntry(customer),
        displayName: this.customerDisplayName(customer),
        displayPhone: this.customerPhone(customer),
        displayAddress: this.customerAddress(customer),
        displayAntiqueLicenseNo: this.customerAntiqueLicenseNo(customer)
      }));
    },
    settlementOptions() {
      const groups = new Map();
      for (const customer of this.customers) {
        if (customer.bidderNo === "") continue;
        const key = customer.customerBookId ? `book:${customer.customerBookId}` : `bidder:${customer.bidderNo}`;
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            customerBookId: customer.customerBookId || "",
            bidderNo: customer.bidderNo,
            name: this.customerDisplayName(customer),
            rows: [],
            sellerLabels: []
          });
        }
        const group = groups.get(key);
        group.rows.push(customer);
        if (!group.name && this.customerDisplayName(customer)) group.name = this.customerDisplayName(customer);
        if (customer.sellerLabel && !group.sellerLabels.includes(customer.sellerLabel)) group.sellerLabels.push(customer.sellerLabel);
      }
      return [...groups.values()].sort((a, b) => Number(a.bidderNo) - Number(b.bidderNo));
    },
    settlementCurrent() {
      if (!this.settlementCustomer && this.settlementOptions[0]) this.settlementCustomer = this.settlementOptions[0].key;
      return this.settlementOptions.find((row) => row.key === this.settlementCustomer) || this.settlementOptions[0] || {};
    },
    settlementSellerOptions() {
      const rows = this.settlementCurrent.rows || [];
      const options = [{ value: "all", label: "全部假名" }];
      for (const row of rows) {
        if (!row.sellerLabel || options.some((option) => option.value === row.sellerLabel)) continue;
        options.push({ value: row.sellerLabel, label: `${row.sellerLabel} · ${this.customerDisplayName(row) || "未命名"}` });
      }
      return options;
    },
    selectedSettlementSellerLabel() {
      return this.settlementSellerOptions.some((option) => option.value === this.settlementSellerScope) && this.settlementSellerScope !== "all"
        ? this.settlementSellerScope
        : "";
    },
    settlementSellerLabelText() {
      return this.selectedSettlementSellerLabel || (this.settlementCurrent.sellerLabels || []).join("｜") || "なし";
    },
    settlementCustomerName() {
      if (this.selectedSettlementSellerLabel) {
        const selected = (this.settlementCurrent.rows || []).find((row) => row.sellerLabel === this.selectedSettlementSellerLabel);
        return this.customerDisplayName(selected) || this.settlementCurrent.name || "";
      }
      return this.settlementCurrent.name || "";
    },
    sellerSettlementRows() {
      return this.settlementRowsFor("seller", this.settlementFilters.showAll);
    },
    buyerSettlementRows() {
      return this.settlementRowsFor("buyer", this.settlementFilters.showAll);
    },
    sellerSettlementCalcRows() {
      return this.settlementRowsFor("seller", this.settlementFilters.showAll || this.settlementFilters.ignoreStatusAmount);
    },
    buyerSettlementCalcRows() {
      return this.settlementRowsFor("buyer", this.settlementFilters.showAll || this.settlementFilters.ignoreStatusAmount);
    },
    sellerTotal() {
      return this.sellerSettlementCalcRows.reduce((sum, row) => sum + row.sellerNet, 0);
    },
    buyerTotal() {
      return this.buyerSettlementCalcRows.reduce((sum, row) => sum + row.buyerTotal, 0);
    },
    settlementNet() {
      return this.buyerTotal - this.sellerTotal;
    },
    settlementSummary() {
      const sum = (rows, key) => rows.reduce((total, row) => total + this.number(row[key]), 0);
      return {
        sellerAmount: sum(this.sellerSettlementCalcRows, "amount"),
        sellerCommission: sum(this.sellerSettlementCalcRows, "sellerCommission"),
        sellerTax: sum(this.sellerSettlementCalcRows, "sellerTax"),
        sellerNet: this.sellerTotal,
        buyerAmount: sum(this.buyerSettlementCalcRows, "amount"),
        buyerCommission: sum(this.buyerSettlementCalcRows, "buyerCommission"),
        buyerTax: sum(this.buyerSettlementCalcRows, "buyerTax"),
        buyerTotal: this.buyerTotal,
        sellerCount: this.sellerSettlementRows.length,
        buyerCount: this.buyerSettlementRows.length
      };
    },
    entryPreview() {
      return this.deriveLot({ ...this.entry, id: this.editingLotId || "draft", buyerConfirmed: false, sellerConfirmed: false, returnConfirmed: false });
    },
    entryWarnings() {
      const row = this.entryPreview;
      const warnings = [];
      if (!row.sellerLabel && row.sellerCode) warnings.push("货主缩写不存在");
      if (!row.itemName && row.itemCode) warnings.push("拍品缩写不存在");
      if (!row.buyerName && row.buyerNo !== "") warnings.push("买家号牌未登记");
      return warnings;
    },
    quickItemCodePreview() {
      const base = this.pinyinInitials(this.quickItemName);
      if (!base) return "";
      return this.availableItemCode(base, this.quickItemName);
    }
  },
  watch: {
    entry: {
      deep: true,
      handler() {
        if (this.liveEntryDirty) this.scheduleLiveEntrySync();
      }
    }
  },
  async mounted() {
    await this.load();
    this.resetEntry(false);
    this.connectEvents();
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    window.addEventListener("keydown", this.handleDashboardKeydown);
    this.clockTimer = setInterval(() => {
      this.now = new Date();
    }, 1000);
  },
  beforeUnmount() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.liveEntrySyncTimer) clearTimeout(this.liveEntrySyncTimer);
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    window.removeEventListener("keydown", this.handleDashboardKeydown);
  },
  methods: {
    blankEntry() {
      return { itemNo: "", sellerCode: "", itemCode: "", quantity: 1, buyerNo: "", priceK: "", note: "" };
    },
    blankCustomer() {
      return {
        customerBookId: "",
        bidderNo: "",
        sellerLabel: "",
        name: "",
        actualSellerName: "",
        actualName: "",
        phone: "",
        address: "",
        antiqueLicenseNo: "",
        sellerRate: "",
        buyerRate: "",
        returnRate: ""
      };
    },
    blankCustomerBook() {
      return { actualName: "", phone: "", address: "", antiqueLicenseNo: "" };
    },
    blankCompanyProfile() {
      return {
        taxId: "",
        postalCode: "",
        address: "",
        logoDataUrl: ""
      };
    },
    async api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    async load() {
      const previousSessionId = this.state?.activeSessionId || "";
      this.state = await this.api("/api/state");
      this.state.companyProfile = { ...this.blankCompanyProfile(), ...(this.state.companyProfile || {}) };
      this.syncCodeDrafts();
      if (previousSessionId && previousSessionId !== this.state.activeSessionId) {
        this.resetSessionUiState();
      }
    },
    connectEvents() {
      const source = new EventSource("/api/events");
      source.addEventListener("hello", () => {
        this.live = true;
      });
      source.addEventListener("state", async () => {
        await this.load();
      });
      source.onerror = () => {
        this.live = false;
      };
    },
    setTab(tab) {
      this.activeTab = tab;
      localStorage.setItem("auction.activeTab", tab);
    },
    async toggleDashboardFullscreen() {
      const screen = this.$refs.dashboardScreen;
      if (!screen) return;
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (this.isDashboardFullscreen && !document.fullscreenElement) {
        this.isDashboardFullscreen = false;
        return;
      }
      try {
        if (screen.requestFullscreen) await screen.requestFullscreen();
        else this.isDashboardFullscreen = true;
      } catch {
        this.isDashboardFullscreen = true;
      }
    },
    handleFullscreenChange() {
      this.isDashboardFullscreen = document.fullscreenElement === this.$refs.dashboardScreen;
    },
    handleDashboardKeydown(event) {
      if (event.key === "Escape" && this.isDashboardFullscreen && !document.fullscreenElement) {
        this.isDashboardFullscreen = false;
      }
    },
    resetSessionUiState() {
      if (this.liveEntrySyncTimer) clearTimeout(this.liveEntrySyncTimer);
      this.editingLotId = "";
      this.editingCustomerId = "";
      this.settlementCustomer = "";
      this.settlementSellerScope = "all";
      this.filterText = "";
      this.dealPlateFilter = "";
      this.selectedLots = new Set();
      this.liveEntryDirty = false;
      this.entrySaveError = "";
      this.entry = {
        ...this.blankEntry(),
        itemNo: this.nextItemNo(),
        sellerCode: "",
        itemCode: ""
      };
    },
    async createSession() {
      this.sessionMessage = "";
      const eventName = this.newSessionName.trim() || "现金拍卖会";
      await this.api("/api/sessions", { method: "POST", body: JSON.stringify({ meta: { eventName } }) });
      this.newSessionName = "";
      await this.load();
      this.resetSessionUiState();
      this.sessionMessage = `已新建并切换到：${eventName}`;
    },
    async switchSession(id) {
      if (!id || id === this.state?.activeSessionId) return;
      await this.api(`/api/sessions/${encodeURIComponent(id)}/switch`, { method: "POST", body: JSON.stringify({}) });
      await this.load();
      this.resetSessionUiState();
      this.sessionMessage = "已切换场次";
    },
    async deleteSession(id) {
      const row = this.sessions.find((session) => session.id === id);
      if (!row) return;
      if (!confirm(`删除场次“${row.eventName || row.id}”？文件会移入 deleted-sessions 目录。`)) return;
      const result = await this.api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await this.load();
      this.resetSessionUiState();
      this.sessionMessage = `已删除场次，文件已移入 ${result.deletedName}`;
    },
    changeSettlementCustomer(value) {
      this.settlementCustomer = value;
      this.settlementSellerScope = "all";
    },
    customerBookEntry(customer = {}) {
      if (!customer.customerBookId) return null;
      return this.state?.customerBook.find((row) => String(row.id) === String(customer.customerBookId)) || null;
    },
    customerDisplayName(customer = {}) {
      const book = this.customerBookEntry(customer);
      return book?.actualName || customer.actualSellerName || customer.name || "";
    },
    customerPhone(customer = {}) {
      return this.customerBookEntry(customer)?.phone || customer.phone || "";
    },
    customerAddress(customer = {}) {
      return this.customerBookEntry(customer)?.address || customer.address || "";
    },
    customerAntiqueLicenseNo(customer = {}) {
      return this.customerBookEntry(customer)?.antiqueLicenseNo || customer.antiqueLicenseNo || "";
    },
    applyCustomerBookSelection() {
      const book = this.state?.customerBook.find((row) => row.id === this.customerForm.customerBookId);
      if (!book) {
        this.customerForm.actualName = "";
        this.customerForm.phone = "";
        this.customerForm.address = "";
        this.customerForm.antiqueLicenseNo = "";
        return;
      }
      this.customerForm.actualName = book.actualName || "";
      this.customerForm.phone = book.phone || "";
      this.customerForm.address = book.address || "";
      this.customerForm.antiqueLicenseNo = book.antiqueLicenseNo || "";
      const existing = this.customers.find((row) => row.customerBookId === book.id && row.bidderNo !== "");
      if (existing) this.customerForm.bidderNo = existing.bidderNo;
    },
    referenceCustomerBook(book) {
      this.editingCustomerId = "";
      this.customerSaveError = "";
      this.customerForm = {
        ...this.blankCustomer(),
        customerBookId: book.id,
        actualName: book.actualName || "",
        phone: book.phone || "",
        address: book.address || "",
        antiqueLicenseNo: book.antiqueLicenseNo || ""
      };
      this.applyCustomerBookSelection();
      document.querySelector(".customer-registration-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    isSettlementReturn(row) {
      return Boolean(row.returnType) || row.sellerAction === "顶待退" || row.sellerAction === "流待退" || row.buyerAction === "顶待退" || row.buyerAction === "流待退";
    },
    settlementRowsFor(mode, ignoreStatus = false) {
      const bidderNo = this.settlementCurrent.bidderNo;
      const customerBookId = this.settlementCurrent.customerBookId || "";
      if ((bidderNo === "" || bidderNo === undefined) && !customerBookId) return [];
      const label = this.selectedSettlementSellerLabel;
      const visibleActions = mode === "seller" ? ["可付", "顶待退", "流待退"] : ["可收", "顶待退", "流待退"];
      return this.lots
        .filter((row) => {
          if (mode === "buyer" && this.settlementFilters.excludeBuyer) return false;
          if (mode === "seller" && this.settlementFilters.excludeSeller) return false;
          if (mode === "buyer" && customerBookId && row.buyerCustomerBookId !== customerBookId) return false;
          if (mode === "seller" && customerBookId && row.sellerCustomerBookId !== customerBookId) return false;
          if (mode === "buyer" && !customerBookId && String(row.buyerNo) !== String(bidderNo)) return false;
          if (mode === "seller" && !customerBookId && String(row.sellerNo) !== String(bidderNo)) return false;
          if (label && row.sellerLabel !== label) return false;

          const isReturn = this.isSettlementReturn(row);
          if (this.settlementFilters.excludeReturns && isReturn) return false;
          if (this.settlementFilters.onlyReturns && !isReturn) return false;
          if (ignoreStatus) return true;

          const action = mode === "seller" ? row.sellerAction : row.buyerAction;
          return visibleActions.includes(action);
        })
        .sort((a, b) => Number(a.itemNo) - Number(b.itemNo));
    },
    nextItemNo() {
      return (this.state?.lots || []).reduce((value, lot) => Math.max(value, this.number(lot.itemNo)), 0) + 1;
    },
    lastSavedSellerCode() {
      const lastLot = [...(this.state?.lots || [])].sort((a, b) => Number(b.itemNo) - Number(a.itemNo))[0];
      return lastLot?.sellerCode || "";
    },
    resetEntry(clearLive = true) {
      this.editingLotId = "";
      this.liveEntryDirty = false;
      if (clearLive) this.syncLiveEntry({});
      this.entry = {
        ...this.blankEntry(),
        itemNo: this.nextItemNo(),
        sellerCode: localStorage.getItem("auction.lastSellerCode") || this.lastSavedSellerCode(),
        itemCode: localStorage.getItem("auction.lastItemCode") || ""
      };
    },
    markEntryDirty() {
      this.entrySaveError = "";
      this.liveEntryDirty = true;
      this.scheduleLiveEntrySync();
    },
    scheduleLiveEntrySync() {
      if (this.liveEntrySyncTimer) clearTimeout(this.liveEntrySyncTimer);
      this.liveEntrySyncTimer = setTimeout(() => {
        this.syncLiveEntry(this.entry);
      }, 120);
    },
    async syncLiveEntry(payload) {
      try {
        await this.api("/api/live-entry", { method: "POST", body: JSON.stringify(payload || {}) });
      } catch {
        this.live = false;
      }
    },
    pickLot(id) {
      this.editingLotId = id;
      if (!id) {
        this.resetEntry();
        return;
      }
      const lot = this.state.lots.find((row) => row.id === id);
      this.entry = { ...this.blankEntry(), ...lot };
    },
    async saveEntry() {
      const missing = this.requiredEntryFields()
        .filter((field) => String(this.entry[field.key] ?? "").trim() === "")
        .map((field) => field.label);
      if (missing.length) {
        this.entrySaveError = `请先填写：${missing.join("、")}`;
        return;
      }
      localStorage.setItem("auction.lastSellerCode", this.entry.sellerCode || "");
      localStorage.setItem("auction.lastItemCode", this.entry.itemCode || "");
      if (this.editingLotId) {
        const existing = this.state.lots.find((lot) => lot.id === this.editingLotId);
        await this.api(`/api/lots/${this.editingLotId}`, { method: "PUT", body: JSON.stringify({ ...existing, ...this.entry }) });
      } else {
        await this.api("/api/lots", { method: "POST", body: JSON.stringify(this.entry) });
      }
      await this.load();
      this.liveEntryDirty = false;
      this.resetEntry();
    },
    requiredEntryFields() {
      return [
        { key: "itemNo", label: "拍品编号" },
        { key: "sellerCode", label: "货主缩写" },
        { key: "itemCode", label: "拍品缩写" },
        { key: "quantity", label: "数量" },
        { key: "buyerNo", label: "买家号牌" },
        { key: "priceK", label: "千单位价" }
      ];
    },
    markNoBid() {
      this.markEntryDirty();
      this.entry.buyerNo = -1;
      this.entry.priceK = this.entry.priceK || 0;
    },
    adjustEntryNumber(key, delta, min = 0) {
      this.markEntryDirty();
      const current = this.entry[key] === "" ? min : this.number(this.entry[key]);
      this.entry[key] = Math.max(min, current + delta);
    },
    editLot(id) {
      this.setTab("record");
      this.pickLot(id);
    },
    async toggleLot(row, key) {
      const lot = this.state.lots.find((item) => item.id === row.id);
      await this.api(`/api/lots/${row.id}`, { method: "PUT", body: JSON.stringify({ ...lot, [key]: !lot[key] }) });
      await this.load();
    },
    async deleteLot(id) {
      if (!confirm("删除这条成交记录？")) return;
      await this.api(`/api/lots/${id}`, { method: "DELETE" });
      this.selectedLots.delete(id);
      await this.load();
    },
    changeSortOrder(value) {
      this.dealSortOrder = value;
      localStorage.setItem("auction.dealSortOrder", value);
    },
    matchesDealPlate(row) {
      if (!this.dealPlateFilter) return true;
      const [kind, value] = this.dealPlateFilter.split(":");
      if (kind === "customer") return String(row.buyerNo) === value || String(row.sellerNo) === value;
      if (kind === "seller") return String(row.sellerLabel) === value;
      return true;
    },
    toggleSelected(id, checked) {
      if (checked) this.selectedLots.add(id);
      else this.selectedLots.delete(id);
      this.selectedLots = new Set(this.selectedLots);
    },
    selectVisible() {
      for (const row of this.dealRows) this.selectedLots.add(row.id);
      this.selectedLots = new Set(this.selectedLots);
    },
    clearSelection() {
      this.selectedLots = new Set();
    },
    async bulkAction(raw) {
      if (!this.selectedLots.size) return;
      const [action, value] = raw.split(":");
      if (action === "delete" && !confirm(`删除已选择的 ${this.selectedLots.size} 条成交记录？`)) return;
      await this.api("/api/lots/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [...this.selectedLots], action, value: value === "1" })
      });
      this.clearSelection();
      await this.load();
    },
    async saveCustomer() {
      this.customerSaveError = "";
      const payload = { ...this.customerForm };
      if (this.editingCustomerId) payload.id = this.editingCustomerId;
      try {
        await this.api("/api/customers", { method: "POST", body: JSON.stringify(payload) });
      } catch (error) {
        this.customerSaveError = String(error.message || error);
        if (this.customerSaveError.includes("customer_book_bidder_conflict")) this.customerSaveError = "同一客户在本场已有买货号牌，不能登记不同买货号牌";
        else if (this.customerSaveError.includes("customer_book_name_required")) this.customerSaveError = "新客户需要填写实际名称";
        else if (this.customerSaveError.includes("customer_book_not_found")) this.customerSaveError = "请选择有效的客户簿客户";
        return;
      }
      this.editingCustomerId = "";
      this.customerForm = this.blankCustomer();
      await this.load();
    },
    editCustomer(customer) {
      this.editingCustomerId = customer.id;
      this.customerSaveError = "";
      const book = this.customerBookEntry(customer);
      this.customerForm = { ...this.blankCustomer(), ...customer, ...(book || {}) };
    },
    async deleteCustomer(id) {
      if (!confirm("删除这个客户？")) return;
      await this.api(`/api/customers/${id}`, { method: "DELETE" });
      await this.load();
    },
    async saveCustomerBook() {
      this.customerBookSaveError = "";
      const payload = { ...this.customerBookForm };
      if (this.editingCustomerBookId) payload.id = this.editingCustomerBookId;
      try {
        await this.api("/api/customer-book", { method: "POST", body: JSON.stringify(payload) });
      } catch (error) {
        this.customerBookSaveError = String(error.message || error).includes("customer_book_name_required") ? "客户簿需要填写实际名称" : String(error.message || error);
        return;
      }
      this.editingCustomerBookId = "";
      this.customerBookForm = this.blankCustomerBook();
      await this.load();
    },
    editCustomerBook(book) {
      this.editingCustomerBookId = book.id;
      this.customerBookSaveError = "";
      this.customerBookForm = { ...this.blankCustomerBook(), ...book };
    },
    async deleteCustomerBook(id) {
      if (!confirm("删除这个客户簿客户？已被本场登记引用的客户不能删除。")) return;
      try {
        await this.api(`/api/customer-book/${id}`, { method: "DELETE" });
      } catch (error) {
        this.customerBookSaveError = String(error.message || error).includes("customer_book_in_use") ? "这个客户已被本场登记引用，不能删除" : String(error.message || error);
        return;
      }
      await this.load();
    },
    async saveMeta() {
      await this.api("/api/meta", { method: "POST", body: JSON.stringify(this.state.meta) });
      await this.load();
    },
    async saveCompanyProfile() {
      this.companyProfileMessage = "";
      try {
        await this.api("/api/company-profile", { method: "POST", body: JSON.stringify(this.companyProfile) });
      } catch (error) {
        this.companyProfileMessage = String(error.message || error).includes("company_logo_invalid") ? "Logo 图片格式不正确，请重新选择图片" : String(error.message || error);
        return;
      }
      this.companyProfileMessage = "公司资料已保存";
      await this.load();
    },
    async companyLogoPicked(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!String(file.type || "").startsWith("image/")) {
        this.companyProfileMessage = "请选择图片文件";
        event.target.value = "";
        return;
      }
      const logoDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("logo_read_failed"));
        reader.readAsDataURL(file);
      });
      this.state.companyProfile.logoDataUrl = logoDataUrl;
      this.companyProfileMessage = "Logo 已选择，请点击保存公司资料";
    },
    removeCompanyLogo() {
      this.state.companyProfile.logoDataUrl = "";
      this.companyProfileMessage = "Logo 已移除，请点击保存公司资料";
    },
    async saveItemCodes() {
      await this.api("/api/codes/items", { method: "POST", body: JSON.stringify(this.parseCodeText(this.itemCodeText(), "name")) });
      await this.load();
    },
    async saveSellerCodes() {
      await this.api("/api/codes/sellers", { method: "POST", body: JSON.stringify(this.parseCodeText(this.sellerCodeText(), "label")) });
      await this.load();
    },
    syncCodeDrafts() {
      this.itemCodeDraft = this.codeText(this.state?.itemCodes || [], "name");
      this.sellerCodeDraft = this.codeText(this.state?.sellerCodes || [], "label");
    },
    itemCodeText() {
      return this.itemCodeDraft;
    },
    sellerCodeText() {
      return this.sellerCodeDraft;
    },
    parseCodeText(text, valueKey) {
      return text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [code, ...rest] = line.split(/[,，\t]/);
          return { code: code.trim(), [valueKey]: rest.join("").trim() };
        })
        .filter((row) => row.code);
    },
    pinyinInitials(text) {
      const boundaries = "吖八嚓咑妸发旮哈讥咔垃妈拏噢妑七呥仨他哇夕丫帀";
      const initials = "ABCDEFGHJKLMNOPQRSTWXYZ";
      return String(text || "")
        .trim()
        .split("")
        .map((char) => {
          if (/[a-z0-9]/i.test(char)) return char[0].toLowerCase();
          if (!/[\u3400-\u9fff]/u.test(char)) return "";
          for (let index = boundaries.length - 1; index >= 0; index -= 1) {
            if (char.localeCompare(boundaries[index], "zh-Hans-CN") >= 0) return initials[index].toLowerCase();
          }
          return "";
        })
        .join("")
        .replace(/[^a-z0-9]/g, "");
    },
    availableItemCode(baseCode, name) {
      const base = String(baseCode || "").toLowerCase();
      if (!base) return "";
      const existing = this.state?.itemCodes || [];
      const sameName = existing.find((row) => row.name === name);
      if (sameName) return sameName.code;
      if (!existing.some((row) => row.code === base)) return base;
      let index = 2;
      while (existing.some((row) => row.code === `${base}${index}`)) index += 1;
      return `${base}${index}`;
    },
    async createQuickItemCode() {
      const name = this.quickItemName.trim();
      if (!name) {
        this.quickItemMessage = "请输入拍品名称";
        return;
      }
      const code = this.quickItemCodePreview;
      if (!code) {
        this.quickItemMessage = "无法生成缩写，请输入中文或字母名称";
        return;
      }
      const existing = this.state.itemCodes.find((row) => row.name === name);
      if (!existing) {
        await this.api("/api/codes/items", {
          method: "POST",
          body: JSON.stringify([...this.state.itemCodes, { code, name }])
        });
        await this.load();
      }
      this.entry.itemCode = code;
      this.markEntryDirty();
      localStorage.setItem("auction.lastItemCode", code);
      this.quickItemName = "";
      this.quickItemMessage = existing ? `已存在：${code}，已填入拍品缩写` : `已新增：${code}，已填入拍品缩写`;
    },
    async importCsv() {
      if (!this.csvFile) {
        this.importMessage = "请选择 CSV 文件";
        return;
      }
      const csv = await this.csvFile.text();
      const imported = await this.api("/api/import/csv", { method: "POST", body: JSON.stringify({ csv, onlyCustomers: this.csvCustomersOnly }) });
      this.importMessage = `已导入客户 ${imported.customers} 条，成交 ${imported.lots} 条`;
      await this.load();
    },
    async clearAuction() {
      if (!confirm("确认清空本场所有成交数据和客户信息？共享代码和场次设置会保留。")) return;
      const cleared = await this.api("/api/auction/clear", { method: "POST", body: JSON.stringify({}) });
      alert(`已清空 ${cleared.count} 条成交数据、${cleared.customers} 条客户信息`);
      this.clearSelection();
      this.resetEntry();
      await this.load();
    },
    filePicked(event) {
      this.csvFile = event.target.files?.[0] || null;
    },
    exportCsv() {
      window.location.href = "/api/export/full.csv";
    },
    openSettlementPreview() {
      this.showSettlementPreview = true;
    },
    printPage() {
      window.print();
    },
    deriveLot(lot) {
      const sellerCode = this.state?.sellerCodes.find((row) => row.code === String(lot.sellerCode || "").toLowerCase());
      const sellerLabel = sellerCode?.label || "";
      const seller = this.state?.customers.find((row) => row.sellerLabel === sellerLabel) || {};
      const buyer = this.state?.customers.find((row) => Number(row.bidderNo) === Number(lot.buyerNo)) || {};
      const item = this.state?.itemCodes.find((row) => row.code === String(lot.itemCode || "").toLowerCase());
      const amount = this.number(lot.priceK) * 1000;
      const buyerNo = lot.buyerNo === "" || lot.buyerNo === undefined ? "" : this.number(lot.buyerNo);
      const isPending = buyerNo === "";
      const isNoBid = buyerNo === -1;
      const isReturn = seller.bidderNo !== undefined && Number(seller.bidderNo) === Number(buyerNo);
      const returnType = isReturn ? "顶价退回" : isNoBid ? "流拍退回" : "";
      const sellerRate = isNoBid ? "NA" : this.number(seller.sellerRate) || this.number(this.state?.meta.sellerCommissionRate);
      const buyerRate = isNoBid ? "NA" : this.number(buyer.buyerRate) || this.number(this.state?.meta.buyerCommissionRate);
      const sellerCommission = isNoBid ? 0 : amount * Number(sellerRate) / 100;
      const buyerCommission = isNoBid ? 0 : amount * Number(buyerRate) / 100;
      const sellerTax = sellerCommission / 10;
      const buyerTax = buyerCommission / 10;
      const badReturnFlags = returnType && (lot.buyerConfirmed || lot.sellerConfirmed);
      const badNormalFlags = !returnType && lot.returnConfirmed;
      let status = "";
      if (lot.itemNo !== "") {
        if (badReturnFlags || badNormalFlags) status = "结算异常！";
        else if (isPending) status = "待拍";
        else if (returnType && lot.returnConfirmed) status = "已退回";
        else if (returnType === "顶价退回") status = "顶价待退回";
        else if (returnType === "流拍退回") status = "流拍待退回";
        else if (lot.buyerConfirmed && lot.sellerConfirmed) status = "已结算";
        else if (lot.buyerConfirmed) status = "等待货主结算";
        else if (lot.sellerConfirmed) status = "货主已结算|买家未付款";
        else status = "未结算";
      }
      const sellerAction = {
        已退回: "已退",
        待拍: "待拍",
        未结算: "待买家",
        等待货主结算: "可付",
        顶价待退回: "顶待退",
        流拍待退回: "流待退",
        已结算: "完成",
        "货主已结算|买家未付款": "待收",
        "结算异常！": "结算异常！"
      }[status] || "";
      const buyerAction = {
        已退: "已退",
        待拍: "待拍",
        待买家: "可收",
        待收: "可收",
        可付: "已收",
        顶待退: "顶待退",
        流待退: "流待退",
        完成: "完成",
        "结算异常！": "结算异常！"
      }[sellerAction] || "";
      const sellerLotCount = (this.state?.lots || [])
        .filter((row) => row.sellerCode === lot.sellerCode)
        .sort((a, b) => Number(a.itemNo) - Number(b.itemNo))
        .findIndex((row) => row.id === lot.id) + 1;
      return {
        ...lot,
        buyerNo,
        amount,
        sellerNo: seller.bidderNo ?? "",
        sellerCustomerBookId: seller.customerBookId || "",
        buyerCustomerBookId: buyer.customerBookId || "",
        sellerLabel,
        sellerLotNo: sellerLabel && sellerLotCount > 0 ? `${sellerLabel}${sellerLotCount}` : "",
        sellerName: this.customerDisplayName(seller),
        buyerName: this.customerDisplayName(buyer),
        sellerPhone: this.customerPhone(seller),
        buyerPhone: this.customerPhone(buyer),
        itemName: item ? `${item.name}${lot.quantity === "" ? "" : this.number(lot.quantity) > 3 ? " 山売" : ` ${lot.quantity}件`}` : "",
        sellerRate,
        sellerCommission,
        sellerTax,
        sellerNet: amount - sellerCommission - sellerTax,
        buyerRate,
        buyerCommission,
        buyerTax,
        buyerTotal: amount + buyerCommission + buyerTax,
        returnType,
        status,
        sellerAction,
        buyerAction
      };
    },
    number(value) {
      if (value === "" || value === null || value === undefined) return 0;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    yen(value) {
      return `¥${money.format(Math.round(this.number(value)))}`;
    },
    moneyText(value) {
      return money.format(Math.round(this.number(value)));
    },
    formatTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("zh-CN", { hour12: false });
    },
    statusClass(status) {
      if (status === "已结算" || status === "完成" || status === "已退回") return "ok";
      if (String(status).includes("异常")) return "danger";
      if (String(status).includes("待") || status === "未结算") return "warn";
      return "info";
    },
    codeText(rows, valueKey) {
      return rows.map((row) => `${row.code},${row[valueKey]}`).join("\n");
    }
  },
  template: `
    <div v-if="!state" class="empty">正在载入...</div>
    <div v-else class="shell" :class="{ 'printing-slip': showSettlementPreview }">
      <header class="topbar">
        <div class="brand">
          <h1>{{ state.meta.eventName || "现金拍卖会" }}</h1>
          <div class="brand-meta">开拍 {{ state.meta.startTime }} · 出货 {{ state.meta.sellerCommissionRate }}% · 买货 {{ state.meta.buyerCommissionRate }}% · 数据 {{ formatTime(state.meta.updatedAt) }}</div>
        </div>
        <div class="sync"><span class="dot" :class="{ live }"></span><span>{{ live ? "协同在线" : "正在连接" }}</span></div>
      </header>

      <nav class="tabs">
        <button v-for="[id, label, icon] in tabs" :key="id" :class="{ active: activeTab === id }" @click="setTab(id)" :title="label"><span aria-hidden="true">{{ icon }}</span> {{ label }}</button>
      </nav>

      <main class="workspace">
        <section v-if="activeTab === 'screen'" ref="dashboardScreen" class="dashboard-screen" :class="{ 'fullscreen-mode': isDashboardFullscreen }">
          <div class="dashboard-hero">
            <div>
              <div class="dashboard-kicker">{{ live ? "LIVE AUCTION" : "CONNECTING" }}</div>
              <h2>{{ state.meta.eventName || "现金拍卖会" }}</h2>
              <p>开拍 {{ state.meta.startTime }} · 数据 {{ formatTime(state.meta.updatedAt) }}</p>
            </div>
            <div class="dashboard-hero-actions">
              <div class="dashboard-clock">{{ dashboardClock }}</div>
              <button class="dashboard-fullscreen-button" @click="toggleDashboardFullscreen" :title="isDashboardFullscreen ? '退出全屏' : '进入全屏'" :aria-label="isDashboardFullscreen ? '退出全屏' : '进入全屏'">
                <span aria-hidden="true">{{ isDashboardFullscreen ? "×" : "⛶" }}</span>
              </button>
            </div>
          </div>

          <div class="dashboard-layout">
            <section class="current-lot">
              <div class="current-lot-meta">
                <span>当前拍品</span>
                <b>No. {{ screenLot.itemNo || "-" }}</b>
              </div>
              <div class="current-lot-title">{{ screenLot.itemName || screenLot.itemCode || "等待录入拍品" }}</div>
              <div class="current-price">{{ yen(screenLot.amount) }}</div>
              <div class="current-lot-grid">
                <div><span>货主</span><b>{{ screenLot.sellerLabel || "-" }} {{ screenLot.sellerName }}</b></div>
                <div><span>买家</span><b>{{ screenLot.buyerNo === "" ? "待拍" : screenLot.buyerNo }} {{ screenLot.buyerName }}</b></div>
                <div><span>数量</span><b>{{ screenLot.quantity || "-" }}</b></div>
                <div><span>状态</span><b>{{ screenLot.status || "正在录入" }}</b></div>
              </div>
            </section>

            <section class="dashboard-metrics">
              <div class="big-metric accent-a"><span>总成交额</span><b>{{ yen(dashboardStats.totalAmount) }}</b><em>{{ dashboardStats.soldCount }} 件成交</em></div>
              <div class="big-metric accent-b"><span>总佣金额</span><b>{{ yen(dashboardStats.totalCommission) }}</b><em>买 {{ yen(dashboardStats.buyerCommission) }} · 卖 {{ yen(dashboardStats.sellerCommission) }}</em></div>
              <div class="big-metric"><span>买方应收</span><b>{{ yen(dashboardStats.buyerReceivable) }}</b><em>含佣金与税</em></div>
              <div class="big-metric"><span>卖方应付</span><b>{{ yen(dashboardStats.sellerPayable) }}</b><em>扣佣金与税</em></div>
              <div class="big-metric"><span>平均成交</span><b>{{ yen(dashboardStats.averageAmount) }}</b><em>最高 {{ yen(dashboardStats.highestAmount) }}</em></div>
              <div class="big-metric"><span>拍品进度</span><b>{{ dashboardStats.soldCount }}/{{ dashboardStats.lotCount }}</b><em>待拍 {{ dashboardStats.pendingCount }} · 退回 {{ dashboardStats.returnCount }}</em></div>
            </section>
          </div>

          <div class="dashboard-grid">
            <section class="dashboard-panel">
              <div class="dashboard-panel-head"><h3>状态分布</h3><span>{{ dashboardStats.lotCount }} 件</span></div>
              <div class="status-bars">
                <div v-for="row in statusBreakdown" :key="row.label" class="status-bar-row">
                  <div class="status-bar-label"><span>{{ row.label }}</span><b>{{ row.count }}</b></div>
                  <div class="status-bar-track"><i :style="{ width: row.percent + '%' }"></i></div>
                </div>
              </div>
            </section>

            <section class="dashboard-panel">
              <div class="dashboard-panel-head"><h3>最高成交</h3><span>{{ dashboardStats.highestLabel }}</span></div>
              <div class="rank-list">
                <div v-for="row in topBidRows" :key="'top-' + row.id" class="rank-row">
                  <div><b>No. {{ row.itemNo }}</b><span>{{ row.itemName || row.itemCode }}</span></div>
                  <strong>{{ yen(row.amount) }}</strong>
                  <i :style="{ width: row.percent + '%' }"></i>
                </div>
                <div v-if="!topBidRows.length" class="dashboard-empty">暂无成交</div>
              </div>
            </section>

            <section class="dashboard-panel">
              <div class="dashboard-panel-head"><h3>货主排行</h3><span>按成交额</span></div>
              <div class="rank-list">
                <div v-for="row in sellerRankRows" :key="'seller-' + row.key" class="rank-row seller-rank">
                  <div><b>{{ row.key }} {{ row.name }}</b><span>{{ row.count }} 件</span></div>
                  <strong>{{ yen(row.amount) }}</strong>
                  <i :style="{ width: row.percent + '%' }"></i>
                </div>
                <div v-if="!sellerRankRows.length" class="dashboard-empty">暂无成交</div>
              </div>
            </section>

            <section class="dashboard-panel">
              <div class="dashboard-panel-head"><h3>最近成交</h3><span>实时更新</span></div>
              <div class="recent-ticker">
                <div v-for="row in recentSoldRows" :key="'screen-recent-' + row.id" class="ticker-row">
                  <span>No. {{ row.itemNo }}</span>
                  <b>{{ row.itemName || row.itemCode }}</b>
                  <strong>{{ yen(row.amount) }}</strong>
                </div>
                <div v-if="!recentSoldRows.length" class="dashboard-empty">暂无成交</div>
              </div>
            </section>
          </div>
        </section>

        <section v-else-if="activeTab === 'record'" class="grid">
          <div class="stats">
            <div class="metric"><span>成交合计</span><b>{{ yen(stats.totalAmount) }}</b></div>
            <div class="metric"><span>待收</span><b>{{ stats.toReceive }}</b></div>
            <div class="metric"><span>可付</span><b>{{ stats.toPay }}</b></div>
            <div class="metric"><span>异常</span><b>{{ stats.bad }}</b></div>
            <div class="metric"><span>拍品数</span><b>{{ stats.count }}</b></div>
          </div>
          <div class="record-layout">
            <section class="panel alt">
              <div class="panel-head"><h2>{{ editingLotId ? "修改拍品信息" : "现场快速录入" }}</h2><button v-if="editingLotId" @click="resetEntry">取消</button></div>
              <div class="panel-body">
                <div class="field full lot-picker">
                  <label>选择指定拍品修改</label>
                  <select :value="editingLotId" @change="pickLot($event.target.value)">
                    <option value="">新拍品 / 自动下一号</option>
                    <option v-for="row in sortedLots" :key="row.id" :value="row.id">{{ row.itemNo }} · {{ row.sellerLabel }} {{ row.itemName || row.itemCode }} · {{ row.buyerNo || "待拍" }}</option>
                  </select>
                </div>
                <form class="entry-form" @input="markEntryDirty" @submit.prevent="saveEntry">
                  <datalist id="sellerCodes"><option v-for="row in state.sellerCodes" :key="row.code" :value="row.code">{{ row.label }}</option></datalist>
                  <datalist id="itemCodes"><option v-for="row in state.itemCodes" :key="row.code" :value="row.code">{{ row.name }}</option></datalist>
                  <datalist id="buyerNos"><option v-for="row in customers" :key="row.id || row.bidderNo" :value="row.bidderNo">{{ customerDisplayName(row) }}</option></datalist>
                  <div class="entry-grid">
                    <div class="field"><label>拍品编号</label><input v-model="entry.itemNo" type="number" autocomplete="off" required /></div>
                    <div class="field"><label>货主缩写</label><input v-model="entry.sellerCode" list="sellerCodes" autocomplete="off" required /></div>
                    <div class="field"><label>拍品缩写</label><input v-model="entry.itemCode" list="itemCodes" autocomplete="off" required /></div>
                    <div class="field"><label>数量</label><div class="stepper-input"><button type="button" @click="adjustEntryNumber('quantity', -1, 1)">−</button><input v-model="entry.quantity" type="number" autocomplete="off" min="1" required /><button type="button" @click="adjustEntryNumber('quantity', 1, 1)">＋</button></div></div>
                    <div class="field"><label>买家号牌</label><input v-model="entry.buyerNo" type="number" list="buyerNos" autocomplete="off" required /></div>
                    <div class="field"><label>千单位价</label><div class="stepper-input price-stepper"><button type="button" @click="adjustEntryNumber('priceK', -1, 0)">−</button><input v-model="entry.priceK" type="number" autocomplete="off" min="0" required /><button type="button" @click="adjustEntryNumber('priceK', 1, 0)">＋</button></div></div>
                    <div class="field full"><label>备注</label><input v-model="entry.note" autocomplete="off" /></div>
                  </div>
                  <div class="preview">
                    <div class="metric"><span>货主</span><b>{{ entryPreview.sellerName || entryPreview.sellerLabel || "未匹配" }}</b></div>
                    <div class="metric"><span>买家</span><b>{{ entryPreview.buyerName || (entryPreview.buyerNo === "" ? "待拍" : "未匹配") }}</b></div>
                    <div class="metric"><span>拍品</span><b>{{ entryPreview.itemName || "未匹配" }}</b></div>
                    <div class="metric"><span>成交额</span><b>{{ yen(entryPreview.amount) }}</b></div>
                    <div v-if="entrySaveError" class="notice field full">{{ entrySaveError }}</div>
                    <div v-if="entryWarnings.length" class="notice field full">{{ entryWarnings.join(" · ") }}</div>
                  </div>
                  <div class="actions entry-actions">
                    <button class="primary" type="submit">{{ editingLotId ? "保存修改" : "保存拍品信息" }}</button>
                    <button type="button" @click="markNoBid">流拍</button>
                    <button type="button" @click="resetEntry">清空</button>
                  </div>
                </form>
                <div class="quick-item-create">
                  <div class="field">
                    <label>快速创建新拍品名称</label>
                    <input v-model="quickItemName" autocomplete="off" placeholder="输入名称，例如 花鸟" @keydown.enter.prevent="createQuickItemCode" />
                  </div>
                  <div class="quick-item-code">
                    <span>缩写</span>
                    <b>{{ quickItemCodePreview || "-" }}</b>
                  </div>
                  <button type="button" @click="createQuickItemCode">加入拍品代码</button>
                  <div v-if="quickItemMessage" class="muted quick-item-message">{{ quickItemMessage }}</div>
                </div>
              </div>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>最近录入</h2><button @click="setTab('deals')">打开成交登记</button></div>
              <div class="table-wrap small-table">
                <div v-if="!recentRows.length" class="empty">暂无记录</div>
                <table v-else>
                  <thead><tr><th>编号</th><th>货主</th><th>拍品</th><th>买家</th><th class="num">成交价</th><th>状态</th><th></th></tr></thead>
                  <tbody><tr v-for="row in recentRows" :key="row.id"><td>{{ row.itemNo }}</td><td>{{ row.sellerLabel }}</td><td>{{ row.itemName || row.itemCode }}</td><td>{{ row.buyerNo }}</td><td class="num">{{ yen(row.amount) }}</td><td><span class="status" :class="statusClass(row.status)">{{ row.status || "-" }}</span></td><td><button class="icon-btn" @click="editLot(row.id)">改</button></td></tr></tbody>
                </table>
              </div>
            </section>
          </div>
        </section>

        <section v-else-if="activeTab === 'deals'" class="grid">
          <div class="stats">
            <div class="metric"><span>成交合计</span><b>{{ yen(stats.totalAmount) }}</b></div>
            <div class="metric"><span>待收</span><b>{{ stats.toReceive }}</b></div>
            <div class="metric"><span>可付</span><b>{{ stats.toPay }}</b></div>
            <div class="metric"><span>异常</span><b>{{ stats.bad }}</b></div>
            <div class="metric"><span>已选择</span><b>{{ selectedLots.size }}</b></div>
          </div>
          <section class="panel">
            <div class="panel-head">
              <h2>成交登记</h2>
              <div class="toolbar no-print">
                <input class="search" v-model="filterText" placeholder="搜索号牌、客户、拍品" />
                <select class="plate-select" v-model="dealPlateFilter" title="号牌筛选"><option value="">全部号牌</option><option v-for="option in dealPlateOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
                <select class="sort-select" :value="dealSortOrder" @change="changeSortOrder($event.target.value)" title="排序"><option value="desc">拍品编号降序</option><option value="asc">拍品编号升序</option></select>
                <button @click="exportCsv">CSV</button>
              </div>
            </div>
            <div class="bulkbar no-print">
              <button @click="selectVisible">选择当前结果</button><button @click="clearSelection">取消选择</button>
              <button @click="bulkAction('buyer:1')">批量收</button><button @click="bulkAction('buyer:0')">取消收</button>
              <button @click="bulkAction('seller:1')">批量付</button><button @click="bulkAction('seller:0')">取消付</button>
              <button @click="bulkAction('return:1')">批量退</button><button @click="bulkAction('return:0')">取消退</button>
              <button class="danger" @click="bulkAction('delete')">删除所选</button>
            </div>
            <div class="table-wrap">
              <div v-if="!dealRows.length" class="empty">暂无成交记录</div>
              <table v-else>
                <thead><tr><th class="no-print"></th><th>编号</th><th>货主</th><th>拍品</th><th class="num">件数</th><th>买家</th><th class="num">成交价</th><th>状态</th><th>买家</th><th>卖家</th><th>退货</th><th class="no-print">操作</th></tr></thead>
                <tbody>
                  <tr v-for="row in dealRows" :key="row.id">
                    <td class="no-print"><input type="checkbox" :checked="selectedLots.has(row.id)" @change="toggleSelected(row.id, $event.target.checked)" /></td>
                    <td>{{ row.itemNo }}</td><td>{{ row.sellerLabel }} {{ row.sellerName }}</td><td>{{ row.itemName || row.itemCode }}</td><td class="num">{{ row.quantity }}</td><td>{{ row.buyerNo }} {{ row.buyerName }}</td><td class="num">{{ yen(row.amount) }}</td>
                    <td><span class="status" :class="statusClass(row.status)">{{ row.status || "-" }}</span></td>
                    <td><button class="icon-btn" :class="{ active: row.buyerConfirmed }" @click="toggleLot(row, 'buyerConfirmed')">收</button></td>
                    <td><button class="icon-btn" :class="{ active: row.sellerConfirmed }" @click="toggleLot(row, 'sellerConfirmed')">付</button></td>
                    <td><button class="icon-btn" :class="{ active: row.returnConfirmed }" @click="toggleLot(row, 'returnConfirmed')">退</button></td>
                    <td class="no-print"><button class="icon-btn" @click="editLot(row.id)">改</button><button class="icon-btn danger" @click="deleteLot(row.id)">删</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <section v-else-if="activeTab === 'settlement'" class="grid">
          <div class="settlement-head">
            <section class="panel settlement-controls">
              <div class="panel-body grid">
                <div class="settlement-picker">
                  <div class="field"><label>客户号牌</label><select :value="settlementCustomer" @change="changeSettlementCustomer($event.target.value)"><option v-for="row in settlementOptions" :key="row.key" :value="row.key">{{ row.bidderNo }} · {{ row.name || "未命名" }}</option></select></div>
                  <div class="field"><label>假名范围</label><select v-model="settlementSellerScope"><option v-for="option in settlementSellerOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></div>
                </div>
                <div class="settlement-switches no-print">
                  <label class="checkline"><input type="checkbox" v-model="settlementFilters.excludeBuyer" /><span>去除买</span></label>
                  <label class="checkline"><input type="checkbox" v-model="settlementFilters.excludeSeller" /><span>去除卖</span></label>
                  <label class="checkline"><input type="checkbox" v-model="settlementFilters.excludeReturns" /><span>去除退货</span></label>
                  <label class="checkline"><input type="checkbox" v-model="settlementFilters.onlyReturns" /><span>只算退货</span></label>
                  <label class="checkline"><input type="checkbox" v-model="settlementFilters.showAll" /><span>全部显示</span></label>
                  <label class="checkline"><input type="checkbox" v-model="settlementFilters.ignoreStatusAmount" /><span>无视结算状态</span></label>
                </div>
              </div>
            </section>
            <section class="panel"><div class="panel-body"><div class="metric"><span>买方应收</span><b>{{ yen(buyerTotal) }}</b></div></div></section>
            <section class="panel"><div class="panel-body"><div class="metric"><span>卖方应付</span><b>{{ yen(sellerTotal) }}</b></div></div></section>
            <section class="panel"><div class="panel-body"><div class="metric"><span>{{ settlementNet >= 0 ? "请款额" : "打款额" }}</span><b>{{ yen(Math.abs(settlementNet)) }}</b></div></div></section>
          </div>
          <section class="panel">
            <div class="panel-head"><h2>精算伝票 · {{ settlementCustomerName }}</h2><div class="actions no-print"><button @click="openSettlementPreview">生成打印预览</button></div></div>
            <div class="panel-body grid">
              <h3 class="section-title">卖方明细</h3><settlement-table :rows="sellerSettlementRows" mode="seller" :yen="yen" :status-class="statusClass" />
              <h3 class="section-title">买方明细</h3><settlement-table :rows="buyerSettlementRows" mode="buyer" :yen="yen" :status-class="statusClass" />
            </div>
          </section>
        </section>

        <section v-else-if="activeTab === 'customers'" class="customer-layout">
          <section class="panel alt customer-registration-panel">
            <div class="panel-head">
              <h2>{{ editingCustomerId ? "修改本场登记" : "本场客户登记" }}</h2>
              <button v-if="editingCustomerId" @click="editingCustomerId = ''; customerSaveError = ''; customerForm = blankCustomer()">取消</button>
            </div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="saveCustomer">
                <div class="field full">
                  <label>从客户簿引用</label>
                  <select v-model="customerForm.customerBookId" @change="applyCustomerBookSelection">
                    <option value="">新登记客户 / 不引用客户簿</option>
                    <option v-for="book in customerBook" :key="book.id" :value="book.id">{{ book.actualName }} · {{ book.phone || "无电话" }}</option>
                  </select>
                </div>
                <div class="field"><label>买货号牌</label><input v-model="customerForm.bidderNo" type="number" /></div>
                <div class="field"><label>出货号牌</label><input v-model="customerForm.sellerLabel" /></div>
                <div class="field full"><label>实际名称</label><input v-model="customerForm.actualName" :readonly="Boolean(customerForm.customerBookId)" :required="!customerForm.customerBookId" /></div>
                <div class="field full"><label>电话</label><input v-model="customerForm.phone" :readonly="Boolean(customerForm.customerBookId)" /></div>
                <div class="field full"><label>地址</label><input v-model="customerForm.address" :readonly="Boolean(customerForm.customerBookId)" /></div>
                <div class="field full"><label>古物商证编号</label><input v-model="customerForm.antiqueLicenseNo" :readonly="Boolean(customerForm.customerBookId)" /></div>
                <div class="field"><label>出货佣金</label><input v-model="customerForm.sellerRate" type="number" /></div>
                <div class="field"><label>买货佣金</label><input v-model="customerForm.buyerRate" type="number" /></div>
                <div class="field"><label>退货佣金</label><input v-model="customerForm.returnRate" type="number" /></div>
                <div v-if="customerSaveError" class="notice field full">{{ customerSaveError }}</div>
                <div class="actions field full"><button class="primary" type="submit">{{ editingCustomerId ? "保存登记" : "新增登记" }}</button></div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>本场登记客户</h2></div>
            <div class="table-wrap">
              <table class="customer-table">
                <thead><tr><th>客户簿ID</th><th>买货号牌</th><th>出货号牌</th><th>实际名称</th><th>电话</th><th>地址</th><th>古物商证编号</th><th>佣金</th><th class="no-print">操作</th></tr></thead>
                <tbody>
                  <tr v-for="row in registeredCustomerRows" :key="row.id || row.bidderNo">
                    <td>{{ row.customerBookId ? row.customerBookId.slice(0, 8) : "-" }}</td><td>{{ row.bidderNo }}</td><td>{{ row.sellerLabel }}</td><td>{{ row.displayName }}</td><td>{{ row.displayPhone }}</td><td>{{ row.displayAddress }}</td><td>{{ row.displayAntiqueLicenseNo }}</td><td>{{ [row.sellerRate, row.buyerRate, row.returnRate].map((v) => v === '' ? '-' : v + '%').join(' / ') }}</td>
                    <td class="no-print"><button class="icon-btn" @click="editCustomer(row)">改</button><button class="icon-btn danger" @click="deleteCustomer(row.id)">删</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="panel alt">
            <div class="panel-head">
              <h2>{{ editingCustomerBookId ? "修改客户簿" : "永久客户簿" }}</h2>
              <button v-if="editingCustomerBookId" @click="editingCustomerBookId = ''; customerBookSaveError = ''; customerBookForm = blankCustomerBook()">取消</button>
            </div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="saveCustomerBook">
                <div class="field full"><label>实际名称</label><input v-model="customerBookForm.actualName" required /></div>
                <div class="field full"><label>电话</label><input v-model="customerBookForm.phone" /></div>
                <div class="field full"><label>地址</label><input v-model="customerBookForm.address" /></div>
                <div class="field full"><label>古物商证编号</label><input v-model="customerBookForm.antiqueLicenseNo" /></div>
                <div v-if="customerBookSaveError" class="notice field full">{{ customerBookSaveError }}</div>
                <div class="actions field full"><button class="primary" type="submit">{{ editingCustomerBookId ? "保存客户簿" : "新增客户簿客户" }}</button></div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>永久客户簿列表</h2>
              <div class="toolbar no-print">
                <input class="search" v-model="customerBookFilter" placeholder="搜索客户簿" />
              </div>
            </div>
            <div class="table-wrap">
              <table class="customer-book-table">
                <thead><tr><th class="no-print">操作</th><th>ID</th><th>实际名称</th><th>电话</th><th>地址</th><th>古物商证编号</th></tr></thead>
                <tbody>
                  <tr v-for="book in filteredCustomerBook" :key="book.id">
                    <td class="no-print"><button @click="referenceCustomerBook(book)">引用</button><button class="icon-btn" @click="editCustomerBook(book)">改</button><button class="icon-btn danger" @click="deleteCustomerBook(book.id)">删</button></td>
                    <td>{{ book.id.slice(0, 8) }}</td><td>{{ book.actualName }}</td><td>{{ book.phone }}</td><td>{{ book.address }}</td><td>{{ book.antiqueLicenseNo }}</td>
                  </tr>
                  <tr v-if="!filteredCustomerBook.length"><td colspan="6" class="empty">{{ customerBookFilter ? "没有匹配的客户簿客户" : "暂无客户簿客户" }}</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <section v-else-if="activeTab === 'settings'" class="grid">
          <section class="panel">
            <div class="panel-head"><h2>拍卖场次管理</h2><div class="muted">当前：{{ activeSession.eventName || state.meta.eventName }}</div></div>
            <div class="panel-body grid">
              <form class="form-grid" @submit.prevent="createSession">
                <div class="field full"><label>新建空白场次名称</label><input v-model="newSessionName" placeholder="例如 2026 春季现金拍卖会" /></div>
                <div class="actions field full"><button class="primary" type="submit">新建并切换</button></div>
              </form>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>场次名称</th><th>开拍</th><th class="num">拍品</th><th class="num">客户</th><th>更新时间</th><th class="no-print">操作</th></tr></thead>
                  <tbody>
                    <tr v-for="session in sessions" :key="session.id" :class="{ selected: session.id === state.activeSessionId }">
                      <td><b>{{ session.eventName }}</b><div class="muted">{{ session.id.slice(0, 8) }}</div></td>
                      <td>{{ session.startTime || "-" }}</td>
                      <td class="num">{{ session.lotCount }}</td>
                      <td class="num">{{ session.customerCount }}</td>
                      <td>{{ formatTime(session.updatedAt) }}</td>
                      <td class="no-print"><button :disabled="session.id === state.activeSessionId" @click="switchSession(session.id)">切换</button><button class="danger" @click="deleteSession(session.id)">删除</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="notice">每个场次独立保存为 data/sessions 下的 JSON 文件；永久客户簿在所有场次之间共享。</div>
              <div v-if="sessionMessage" class="muted">{{ sessionMessage }}</div>
            </div>
          </section>
          <section class="panel"><div class="panel-head"><h2>场次设置</h2></div><div class="panel-body"><form class="form-grid" @submit.prevent="saveMeta"><div class="field full"><label>拍卖会名称</label><input v-model="state.meta.eventName" /></div><div class="field"><label>开拍时间</label><input v-model="state.meta.startTime" /></div><div class="field"><label>默认出货佣金</label><input v-model="state.meta.sellerCommissionRate" type="number" /></div><div class="field"><label>默认买货佣金</label><input v-model="state.meta.buyerCommissionRate" type="number" /></div><div class="field"><label>默认退货佣金</label><input v-model="state.meta.returnCommissionRate" type="number" /></div><div class="actions field full"><button class="primary" type="submit">保存设置</button></div></form></div></section>
          <section class="panel">
            <div class="panel-head"><h2>公司资料</h2><div class="muted">所有场次共用</div></div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="saveCompanyProfile">
                <div class="field"><label>税号</label><input v-model="state.companyProfile.taxId" /></div>
                <div class="field"><label>邮编</label><input v-model="state.companyProfile.postalCode" /></div>
                <div class="field full"><label>地址</label><textarea v-model="state.companyProfile.address"></textarea></div>
                <div class="field"><label>公司 Logo</label><input type="file" accept="image/*" @change="companyLogoPicked" /></div>
                <div class="company-logo-preview">
                  <img v-if="state.companyProfile.logoDataUrl" :src="state.companyProfile.logoDataUrl" alt="公司 Logo 预览" />
                  <div v-else class="muted">未设置 Logo</div>
                </div>
                <div class="actions field full">
                  <button class="primary" type="submit">保存公司资料</button>
                  <button type="button" @click="removeCompanyLogo" :disabled="!state.companyProfile.logoDataUrl">移除 Logo</button>
                </div>
                <div v-if="companyProfileMessage" class="muted field full">{{ companyProfileMessage }}</div>
              </form>
            </div>
          </section>
          <section class="panel"><div class="panel-head"><h2>数据导入与清场</h2></div><div class="panel-body grid"><div class="form-grid"><div class="field"><label>导入 CSV</label><input type="file" accept=".csv,text/csv" @change="filePicked" /></div><label class="checkline"><input type="checkbox" v-model="csvCustomersOnly" /><span>只导入客户信息</span></label></div><div class="notice">CSV 表头可使用旧表字段：客户号牌、出货号牌、客户名称、拍品编号、货主出货号牌缩写、拍品名称缩写、拍品数量、买家客户号牌、千单位成交价。</div><div class="actions"><button class="primary" @click="importCsv">导入 CSV</button><button class="danger" @click="clearAuction">清空本场拍卖与客户数据</button></div><div class="muted">{{ importMessage }}</div></div></section>
          <section class="code-grid"><section class="panel"><div class="panel-head"><h2>拍品代码</h2></div><div class="panel-body field"><label>每行：缩写,名称</label><textarea id="item-code-text" v-model="itemCodeDraft"></textarea><div class="actions"><button class="primary" @click="saveItemCodes">保存拍品代码</button></div></div></section><section class="panel"><div class="panel-head"><h2>出货号牌代码</h2></div><div class="panel-body field"><label>每行：英文缩写,日文号牌</label><textarea id="seller-code-text" v-model="sellerCodeDraft"></textarea><div class="actions"><button class="primary" @click="saveSellerCodes">保存号牌代码</button></div></div></section></section>
        </section>

        <section v-else class="panel">
          <div class="panel-head"><h2>完整成交明细</h2><div class="actions no-print"><button @click="exportCsv">下载 CSV</button><button @click="printPage">打印</button></div></div>
          <div class="table-wrap"><div v-if="!sortedLots.length" class="empty">暂无明细</div><table v-else><thead><tr><th>拍品编号</th><th>货主拍品编号</th><th>货主编号</th><th>货主名称</th><th>拍品名称</th><th>买家编号</th><th>买家名称</th><th class="num">成交价格</th><th class="num">货主结算额</th><th class="num">买家结算额</th><th>退回</th><th>状态</th></tr></thead><tbody><tr v-for="row in sortedLots" :key="row.id"><td>{{ row.itemNo }}</td><td>{{ row.sellerLotNo }}</td><td>{{ row.sellerNo }}</td><td>{{ row.sellerName }}</td><td>{{ row.itemName }}</td><td>{{ row.buyerNo }}</td><td>{{ row.buyerName }}</td><td class="num">{{ yen(row.amount) }}</td><td class="num">{{ yen(row.sellerNet) }}</td><td class="num">{{ yen(row.buyerTotal) }}</td><td>{{ row.returnType }}</td><td><span class="status" :class="statusClass(row.status)">{{ row.status || "-" }}</span></td></tr></tbody></table></div>
        </section>

        <div v-if="showSettlementPreview" class="print-preview-overlay">
          <div class="preview-actions no-print">
            <button @click="showSettlementPreview = false">关闭</button>
            <button class="primary" @click="printPage">打印</button>
          </div>
          <article class="slip-page">
            <header class="slip-header">
              <div class="slip-company">
                <img v-if="companyProfile.logoDataUrl" class="slip-logo" :src="companyProfile.logoDataUrl" alt="Company logo" />
              </div>
              <div class="slip-title">
                <h2>精算伝票</h2>
              </div>
              <div class="slip-tax-id">{{ companyProfile.taxId }}</div>
            </header>

            <section class="slip-customer-row">
              <div class="slip-left-stack">
                <div class="slip-name">{{ settlementCustomerName }} 様</div>
                <div class="slip-summary">
                  <table>
                    <thead>
                      <tr><th></th><th colspan="2">買</th><th colspan="2">売</th></tr>
                      <tr><th></th><th>税込</th><th>消費税</th><th>税込</th><th>消費税</th></tr>
                    </thead>
                    <tbody>
                      <tr><th>合計</th><td>{{ yen(settlementSummary.buyerTotal) }}</td><td>{{ yen(settlementSummary.buyerTax) }}</td><td>{{ yen(settlementSummary.sellerAmount) }}</td><td>{{ yen(settlementSummary.sellerTax) }}</td></tr>
                      <tr><th>手数料</th><td>{{ yen(settlementSummary.buyerCommission) }}</td><td>{{ yen(settlementSummary.buyerTax) }}</td><td>{{ yen(settlementSummary.sellerCommission) }}</td><td>{{ yen(settlementSummary.sellerTax) }}</td></tr>
                      <tr><th>正味</th><td colspan="2">{{ yen(settlementSummary.buyerTotal) }}</td><td colspan="2">{{ yen(settlementSummary.sellerNet) }}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div class="slip-meta">
                <div class="slip-meta-event">{{ state.meta.eventName }}</div>
                <div class="slip-meta-address" v-if="companyPostalLine || companyAddressLines.length">
                  <div v-if="companyPostalLine">{{ companyPostalLine }}</div>
                  <div v-for="line in companyAddressLines" :key="line">{{ line }}</div>
                </div>
                <div>パドル番号: {{ settlementCurrent.bidderNo || "" }}</div>
                <div>荷主コード: {{ settlementSellerLabelText }}</div>
                <div class="slip-meta-date">プリント日付： {{ new Date().toLocaleDateString("ja-JP") }}</div>
              </div>
            </section>

            <footer class="slip-footer">
              <div class="slip-billing">{{ settlementNet >= 0 ? "ご請求额:" : "お振込额:" }} {{ yen(Math.abs(settlementNet)) }}</div>
            </footer>

            <section class="slip-lines">
              <div class="slip-table seller">
                <div class="slip-table-title">売　計{{ settlementSummary.sellerCount }}点</div>
                <table>
                  <thead><tr><th>番号</th><th>番号3</th><th>名称</th><th>金額</th></tr></thead>
                  <tbody>
                    <tr v-for="row in sellerSettlementRows" :key="'preview-seller-' + row.id"><td>{{ row.itemNo }}</td><td>{{ row.sellerLotNo }}</td><td>{{ row.itemName }}</td><td>{{ moneyText(row.amount) }}</td></tr>
                    <tr v-if="!sellerSettlementRows.length"><td colspan="4">无记录</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="slip-table buyer">
                <div class="slip-table-title">買　計{{ settlementSummary.buyerCount }}点</div>
                <table>
                  <thead><tr><th>番号</th><th>番号3</th><th>名称</th><th>金額</th></tr></thead>
                  <tbody>
                    <tr v-for="row in buyerSettlementRows" :key="'preview-buyer-' + row.id"><td>{{ row.itemNo }}</td><td>{{ row.sellerLotNo }}</td><td>{{ row.itemName }}</td><td>{{ moneyText(row.amount) }}</td></tr>
                    <tr v-if="!buyerSettlementRows.length"><td colspan="4">无记录</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          </article>
        </div>
      </main>
    </div>
  `
})
  .component("settlement-table", {
    props: ["rows", "mode", "yen", "statusClass"],
    template: `
      <div v-if="!rows.length" class="empty">无记录</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>编号</th><th>货主编号</th><th>名称</th><th class="num">成交价</th><th class="num">佣金</th><th class="num">税</th><th class="num">结算额</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id + mode">
              <td>{{ row.itemNo }}</td><td>{{ row.sellerLotNo }}</td><td>{{ row.itemName }}</td><td class="num">{{ yen(row.amount) }}</td>
              <td class="num">{{ yen(mode === "seller" ? row.sellerCommission : row.buyerCommission) }}</td>
              <td class="num">{{ yen(mode === "seller" ? row.sellerTax : row.buyerTax) }}</td>
              <td class="num">{{ yen(mode === "seller" ? row.sellerNet : row.buyerTotal) }}</td>
              <td><span class="status" :class="statusClass(mode === 'seller' ? row.sellerAction : row.buyerAction)">{{ mode === "seller" ? row.sellerAction : row.buyerAction }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    `
  })
  .mount("#app");
