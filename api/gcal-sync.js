// ============================================================
// Google Calendar 雙向同步 API
// 路徑：/api/gcal-sync
// 用途：網頁 ↔ Google Calendar 的代理層
// 支援多品牌（meowling / hulu / tongling / jennyoga）
// ============================================================

import { google } from 'googleapis';

// ---------- 建立 Google Calendar 授權 ----------
function getAuth() {
  // 從環境變數讀取金鑰
  const privateKey = process.env.GCAL_PRIVATE_KEY.replace(/\\n/g, '\n');
  const clientEmail = process.env.GCAL_CLIENT_EMAIL;

  const auth = new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/calendar']
  );

  return auth;
}

// ---------- 依品牌取得對應的 Calendar ID ----------
// 環境變數預期：
//   GCAL_CALENDAR_ID            → 妙靈（沿用原本的，向下相容）
//   GCAL_CALENDAR_ID_HULU       → 葫蘆流
//   GCAL_CALENDAR_ID_TONGLING   → 通通靈
//   GCAL_CALENDAR_ID_JENNYOGA   → jennyoga（之後再補）
function getCalendarIdByBrand(brand) {
  // brand 會是中文（妙靈 / 葫蘆流 / 通通靈 / jennyoga）或英文 key
  const map = {
    '妙靈': process.env.GCAL_CALENDAR_ID,
    'meowling': process.env.GCAL_CALENDAR_ID,
    '葫蘆流': process.env.GCAL_CALENDAR_ID_HULU,
    'hulu': process.env.GCAL_CALENDAR_ID_HULU,
    '通通靈': process.env.GCAL_CALENDAR_ID_TONGLING,
    'tongling': process.env.GCAL_CALENDAR_ID_TONGLING,
    'jennyoga': process.env.GCAL_CALENDAR_ID_JENNYOGA,
  };
  // 找不到就 fallback 到妙靈（避免完全失效，保留向下相容）
  return map[brand] || process.env.GCAL_CALENDAR_ID;
}

// ---------- 主 API 處理函式 ----------
export default async function handler(req, res) {
  // 允許跨來源請求（CORS）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 處理 OPTIONS 預檢請求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    // 從 URL 查詢參數或 POST body 取得資料
    const params = req.method === 'GET' ? req.query : req.body;
    const action = params.action;

    // ---------- 路由不同的 action ----------
    switch (action) {

      // ========== 1. 健康檢查（測試用） ==========
      case 'ping': {
        return res.status(200).json({
          ok: true,
          message: 'API 正常運作',
          time: new Date().toISOString(),
          serviceAccount: process.env.GCAL_CLIENT_EMAIL,
          calendars: {
            meowling: process.env.GCAL_CALENDAR_ID ? '已設定' : '未設定',
            hulu: process.env.GCAL_CALENDAR_ID_HULU ? '已設定' : '未設定',
            tongling: process.env.GCAL_CALENDAR_ID_TONGLING ? '已設定' : '未設定',
            jennyoga: process.env.GCAL_CALENDAR_ID_JENNYOGA ? '已設定' : '未設定',
          },
        });
      }

      // ========== 2. 新增事件 ==========
      case 'create': {
        const { title, date, dateEnd, time, kw, note, brand, editor } = params;

        if (!title || !date) {
          return res.status(400).json({ ok: false, error: '缺少 title 或 date' });
        }

        const calendarId = getCalendarIdByBrand(brand);
        if (!calendarId) {
          return res.status(400).json({ ok: false, error: `品牌「${brand}」尚未設定 Calendar ID` });
        }

        // 處理日期時間
        const eventResource = buildEventResource({
          title, date, dateEnd, time, kw, note, brand, editor
        });

        const result = await calendar.events.insert({
          calendarId: calendarId,
          requestBody: eventResource,
        });

        return res.status(200).json({
          ok: true,
          gcalId: result.data.id,
          htmlLink: result.data.htmlLink,
          calendarId: calendarId,
        });
      }

      // ========== 3. 修改事件 ==========
      case 'update': {
        const { gcalId, title, date, dateEnd, time, kw, note, brand, editor } = params;

        if (!gcalId) {
          return res.status(400).json({ ok: false, error: '缺少 gcalId' });
        }

        const calendarId = getCalendarIdByBrand(brand);
        if (!calendarId) {
          return res.status(400).json({ ok: false, error: `品牌「${brand}」尚未設定 Calendar ID` });
        }

        const eventResource = buildEventResource({
          title, date, dateEnd, time, kw, note, brand, editor
        });

        const result = await calendar.events.update({
          calendarId: calendarId,
          eventId: gcalId,
          requestBody: eventResource,
        });

        return res.status(200).json({
          ok: true,
          gcalId: result.data.id,
        });
      }

      // ========== 4. 刪除事件 ==========
      case 'delete': {
        const { gcalId, brand } = params;

        if (!gcalId) {
          return res.status(400).json({ ok: false, error: '缺少 gcalId' });
        }

        const calendarId = getCalendarIdByBrand(brand);
        if (!calendarId) {
          return res.status(400).json({ ok: false, error: `品牌「${brand}」尚未設定 Calendar ID` });
        }

        try {
          await calendar.events.delete({
            calendarId: calendarId,
            eventId: gcalId,
          });
          return res.status(200).json({ ok: true });
        } catch (err) {
          // 如果事件已經不存在，視為成功（不阻擋刪除流程）
          if (err.code === 404 || err.code === 410) {
            return res.status(200).json({ ok: true, note: '事件已不存在' });
          }
          throw err;
        }
      }

      // ========== 5. 讀取事件列表 ==========
      case 'list': {
        const { calendarIds, timeMin, timeMax } = params;

        // 支援讀取多個行事曆（例如主行事曆 + 唯讀的祁祁 + 唯讀的夥伴）
        const idList = calendarIds
          ? calendarIds.split(',').map(s => s.trim()).filter(Boolean)
          : [process.env.GCAL_CALENDAR_ID];

        // 預設讀取：從 1 個月前到 3 個月後
        const defaultMin = new Date();
        defaultMin.setMonth(defaultMin.getMonth() - 1);
        const defaultMax = new Date();
        defaultMax.setMonth(defaultMax.getMonth() + 3);

        const allEvents = [];
        for (const calId of idList) {
          try {
            const result = await calendar.events.list({
              calendarId: calId,
              timeMin: timeMin || defaultMin.toISOString(),
              timeMax: timeMax || defaultMax.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 500,
            });

            const events = (result.data.items || []).map(ev => ({
              gcalId: ev.id,
              calendarId: calId,
              title: ev.summary || '(無標題)',
              date: ev.start?.date || ev.start?.dateTime?.substring(0, 10),
              dateEnd: ev.end?.date || ev.end?.dateTime?.substring(0, 10),
              time: ev.start?.date ? 'allday' : ev.start?.dateTime?.substring(11, 16),
              description: ev.description || '',
              location: ev.location || '',
              htmlLink: ev.htmlLink,
              updated: ev.updated,
            }));

            allEvents.push(...events);
          } catch (err) {
            // 某一個行事曆讀不到（例如夥伴撤銷了權限），不阻擋其他的
            console.error(`讀取 ${calId} 失敗:`, err.message);
          }
        }

        return res.status(200).json({
          ok: true,
          count: allEvents.length,
          events: allEvents,
        });
      }

      // ========== 未知 action ==========
      default: {
        return res.status(400).json({
          ok: false,
          error: '不支援的 action',
          supported: ['ping', 'create', 'update', 'delete', 'list'],
        });
      }
    }

  } catch (err) {
    console.error('API 錯誤:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      code: err.code,
    });
  }
}

// ============================================================
// 輔助函式：把網頁傳來的資料轉成 Google Calendar 的事件格式
// ============================================================
function buildEventResource({ title, date, dateEnd, time, kw, note, brand, editor }) {
  // 組合事件標題
  const summary = brand ? `【${brand}】${title}` : title;

  // 組合描述（含編輯者記錄，類似「誰動的」功能）
  const descLines = [];
  if (kw) descLines.push(`備註：${kw}`);
  if (note) descLines.push(note);
  if (editor) descLines.push(`— 編輯：${editor}（${new Date().toLocaleDateString('zh-TW')}）`);
  const description = descLines.join('\n');

  // 處理全天事件 vs 有時間事件
  let start, end;
  if (!time || time === 'allday') {
    // 全天事件
    start = { date };
    end = { date: dateEnd ? addOneDay(dateEnd) : addOneDay(date) };
  } else {
    // 有時間的事件（預設 1 小時長）
    const [h, m] = time.split(':');
    const startH = h.padStart(2, '0');
    const startM = (m || '00').padStart(2, '0');
    const endH = String(parseInt(h) + 1).padStart(2, '0');

    start = {
      dateTime: `${date}T${startH}:${startM}:00`,
      timeZone: 'Asia/Taipei',
    };
    end = {
      dateTime: `${date}T${endH}:${startM}:00`,
      timeZone: 'Asia/Taipei',
    };
  }

  return {
    summary,
    description,
    start,
    end,
  };
}

// 日期 +1 天（給全天事件的 end 用，Google Calendar 規則）
function addOneDay(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().substring(0, 10);
}
