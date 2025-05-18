import 'dotenv/config';
import { Browser, Page, chromium } from 'playwright';
import { db } from './index.js';
import { horses, races, tanOddsHistory, fukuOdds, wakurenOdds, umarenOdds, wideOdds, umatanOdds, fuku3Odds, tan3Odds } from './schema.js';
import { eq, sql, and } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import { WakurenOdds, UmarenOdds, WideOdds, UmatanOdds, Fuku3Odds, Tan3Odds } from './schema.js';

declare global {
  interface Window {
    doAction: (url: string, param: string) => void;
  }
}


interface OddsData {
  horseId: number;
  horseName: string;
  frame: number;
  number: number;
  tanOdds: number;
  fukuOddsMin: number;
  fukuOddsMax: number;
  timestamp: Date;
  raceId: number;
  status: string;
}

// 枠連オッズのインターフェースを追加
interface WakurenOddsData {
  frame1: number;
  frame2: number;
  odds: number;
  timestamp: Date;
  raceId: number;
}

interface UmarenOddsData {
  horse1: number;
  horse2: number;
  odds: number;
  timestamp: Date;
  raceId: number;
}

interface BetTypeConfig {
  tabName: string;          // タブの名前（'枠連'、'馬連'など）
  tableSelector: string;    // テーブルのセレクタ
  parser: (html: string, raceId: number) => Promise<any[]>; // パーサー関数
}

// インターフェースの追加
interface WideOddsData {
  horse1: number;
  horse2: number;
  oddsMin: number;
  oddsMax: number;
  timestamp: Date;
  raceId: number;
}

// インターフェースの追加
interface UmatanOddsData {
  horse1: number;  // 1着となる馬
  horse2: number;  // 2着となる馬
  odds: number;
  timestamp: Date;
  raceId: number;
}

// インターフェースの追加
interface Fuku3OddsData {
  horse1: number;
  horse2: number;
  horse3: number;
  odds: number;
  timestamp: Date;
  raceId: number;
}

// インターフェースの追加
interface Tan3OddsData {
  horse1: number;  // 1着となる馬
  horse2: number;  // 2着となる馬
  horse3: number;  // 3着となる馬
  odds: number;
  timestamp: Date;
  raceId: number;
}

const BATCH_SIZES = {
  tanpuku: 20,    // 単複（比較的少量）
  wakuren: 40,    // 枠連（中程度）
  umaren: 200,     // 馬連（中程度）
  wide: 200,       // ワイド（中程度）
  umatan: 400,     // 馬単（多め）
  fuku3: 1000,     // 3連複（大量）
  tan3: 1000       // 3連単（大量）
} as const;

export class OddsCollector {
  private browser: Browser | null = null;
  private contextPool: Array<{ context: any, inUse: boolean, lastUsed: Date }> = [];
  private readonly MAX_CONTEXTS = 5; // 最大コンテキスト数
  private readonly CONTEXT_TIMEOUT = 10 * 60 * 1000; // 10分間使用されていないコンテキストは閉じる
  
  private betTypes: { [key: string]: BetTypeConfig } = {
    tanpuku: {
      tabName: '単勝・複勝',
      tableSelector: 'table.basic.narrow-xy.tanpuku',
      parser: this.parseTanpukuOdds.bind(this)
    },
    wakuren: {
      tabName: '枠連',
      tableSelector: 'table.basic.narrow-xy.waku',
      parser: this.parseWakurenOdds.bind(this)
    },
    umaren: {
      tabName: '馬連',
      tableSelector: 'table.basic.narrow-xy.umaren',
      parser: this.parseUmarenOdds.bind(this)
    },
    wide: {
      tabName: 'ワイド',
      tableSelector: 'table.basic.narrow-xy.wide',
      parser: this.parseWideOdds.bind(this)
    },
    umatan: {
      tabName: '馬単',
      tableSelector: 'table.basic.narrow-xy.umatan',
      parser: this.parseUmatanOdds.bind(this)
    },
    fuku3: {
      tabName: '3連複',
      tableSelector: 'table.basic.narrow-xy.fuku3',
      parser: this.parseFuku3Odds.bind(this)
    },
    tan3: {
      tabName: '3連単',
      tableSelector: 'table.basic.narrow-xy.tan3',
      parser: this.parseTan3Odds.bind(this)
    },
    // 他の馬券種別も同様に定義
  };

  async initialize(browser?: Browser) {
    try {
      // 外部から渡されたブラウザインスタンスがあれば使用
      if (browser) {
        this.browser = browser;
        console.log('Using existing browser instance for OddsCollector');
      } else {
        // 独自のブラウザインスタンスを作成（フォールバック）
        console.log('Creating new browser instance for OddsCollector');
        this.browser = await chromium.launch({ 
          headless: true,
          executablePath: process.env.CHROME_BIN || undefined,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer'
          ]
        });
      }
      
      // コンテキストプールをクリア
      this.contextPool = [];
      
      // 古いコンテキストを定期的にクリーンアップするタイマーを設定
      setInterval(() => this.cleanupUnusedContexts(), 60000); // 1分ごとにチェック
      
      console.log('OddsCollector initialized successfully');
    } catch (error) {
      console.error('Failed to initialize OddsCollector:', error);
      throw error;
    }
  }

  // 未使用のコンテキストをクリーンアップ
  private async cleanupUnusedContexts() {
    const now = new Date();
    const newPool = [];
    
    for (const item of this.contextPool) {
      if (!item.inUse && now.getTime() - item.lastUsed.getTime() > this.CONTEXT_TIMEOUT) {
        try {
          await item.context.close();
          console.log('Closed unused browser context');
        } catch (error) {
          console.error('Error closing unused context:', error);
        }
      } else {
        newPool.push(item);
      }
    }
    
    this.contextPool = newPool;
  }
  
  // コンテキストプールからコンテキストを取得または新規作成
  private async getContext(): Promise<any> {
    // 未使用のコンテキストを探す
    for (const item of this.contextPool) {
      if (!item.inUse) {
        item.inUse = true;
        item.lastUsed = new Date();
        return item.context;
      }
    }
    
    // プールが最大サイズに達していない場合は新しいコンテキストを作成
    if (this.contextPool.length < this.MAX_CONTEXTS && this.browser) {
      try {
        const context = await this.browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        const poolItem = {
          context,
          inUse: true,
          lastUsed: new Date()
        };
        
        this.contextPool.push(poolItem);
        return context;
      } catch (error) {
        console.error('Error creating new browser context:', error);
        throw error;
      }
    }
    
    // プールが最大サイズに達している場合は待機してから再試行
    console.log('Context pool is full, waiting for available context...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    return this.getContext();
  }
  
  // コンテキストを解放
  private releaseContext(context: any): void {
    for (const item of this.contextPool) {
      if (item.context === context) {
        item.inUse = false;
        item.lastUsed = new Date();
        return;
      }
    }
  }

  async collectOddsForBetType(raceId: number, betType: string, pastRaceUrl?: string): Promise<any[]> {
    if (!this.browser || !this.betTypes[betType]) {
      throw new Error('Invalid configuration');
    }

    let context: any = null;
    let page: any = null;
    
    try {
      // コンテキストプールからコンテキストを取得
      context = await this.getContext();
      page = await context.newPage();

      // 共通のページ遷移ロジック
      await this.navigateToRacePage(page, raceId, pastRaceUrl);
      
      // 馬券種別タブへの遷移
      const config = this.betTypes[betType];
      if (betType !== 'tanpuku') { // 単複は最初のタブなのでスキップ
        if (betType === 'wide') {
          // ワイドオッズの場合は、onclick属性を持つリンクを探す
          await page.locator('a[onclick*="accessO.html"]').filter({ hasText: 'ワイド' }).click();
        } else {
          await page.getByRole('link', { name: config.tabName }).click();
        }
        await page.waitForLoadState('networkidle');
      }

      // テーブルの待機
      await page.waitForSelector(config.tableSelector, { timeout: 30000 });
      await page.waitForTimeout(2000); // 追加：データ読み込み待機

      const html = await page.content();
      console.log('Current URL:', page.url()); // デバッグ情報
      console.log('Page content length:', html.length);

      // 馬券種別固有のパース処理
      const oddsData = await config.parser(html, raceId);

      const sortedHorses = oddsData.sort((a, b) => {
        if (a.frame === b.frame) {
          return a.number - b.number;
        }
        return a.frame - b.frame;
      });

      // ページを閉じる（コンテキストは再利用）
      await page.close();
      
      return sortedHorses;
    } catch (error) {
      console.error(`Error collecting ${betType} odds for race ${raceId}:`, error);
      
      // エラー発生時はページとコンテキストを閉じて新しいものを使用するようにする
      if (page) {
        try {
          await page.close();
        } catch (closeError) {
          console.error('Error closing page:', closeError);
        }
      }
      
      // コンテキストプールから削除
      if (context) {
        const index = this.contextPool.findIndex(item => item.context === context);
        if (index !== -1) {
          try {
            await this.contextPool[index].context.close();
          } catch (closeError) {
            console.error('Error closing context:', closeError);
          }
          this.contextPool.splice(index, 1);
        }
      }
      
      throw error;
    } finally {
      // コンテキストを解放（エラーがなければ再利用可能にする）
      if (context) {
        this.releaseContext(context);
      }
    }
  }

  private async navigateToRacePage(page: Page, raceId: number, pastRaceUrl?: string): Promise<void> {
    if (pastRaceUrl) {
      // 過去レースの場合
      await page.goto(pastRaceUrl);
      await page.waitForLoadState('networkidle');

      // race_related_linkクラス内の最初のオッズボタンをクリック
      const oddsButton = await page.locator('div.race_related_link a[href="#"]').first();
      await oddsButton.click();
      await page.waitForLoadState('networkidle');
    } else {
      // 現在のレースの場合（既存のロジック）
      await page.goto('https://www.jra.go.jp/keiba/');
      await page.waitForLoadState('networkidle');
      
      await page.getByRole('link', { name: 'オッズ', exact: true }).click();
      await page.waitForLoadState('networkidle');

      const raceIdStr = raceId.toString();
      const kaisaiKai = parseInt(raceIdStr.slice(6,8)).toString();
      const kaisaiNichi = parseInt(raceIdStr.slice(8,10)).toString();
      const kaisaiName = `${kaisaiKai}回${placeMapping[raceIdStr.slice(4,6)]}${kaisaiNichi}日`;
      
      await page.getByRole('link', { name: kaisaiName }).click();
      await page.waitForLoadState('networkidle');
      
      const raceNumber = parseInt(raceIdStr.slice(10,12));
      await page.locator(`img[alt="${raceNumber}レース"]`).click();
      await page.waitForLoadState('networkidle');
    }
  }

  // 各馬券種別のパーサー関数
  private async parseTanpukuOdds(html: string, raceId: number): Promise<OddsData[]> {
    const $ = cheerio.load(html);
    const oddsData: OddsData[] = [];
    const processedHorseIds = new Set<number>();

    let currentFrame = 0;
    let remainingRowspan = 0;

    console.log(`Starting to parse odds for race ${raceId}`);

    $('table.basic.narrow-xy.tanpuku tr').each((index, element) => {
      const row = $(element);
      
      // 馬番を取得
      const horseNumberCell = row.find('td.num');
      if (!horseNumberCell.length) {
        console.log(`Row ${index}: No horse number cell found`);
        return;
      }
      
      const horseNumber = horseNumberCell.text().trim();
      if (!horseNumber || isNaN(parseInt(horseNumber))) {
        console.log(`Row ${index}: Invalid horse number: ${horseNumber}`);
        return;
      }

      const horseId = parseInt(horseNumber);
      if (processedHorseIds.has(horseId)) {
        console.log(`Row ${index}: Horse ${horseId} already processed`);
        return;
      }

      // 枠番を取得
      const wakuCell = row.find('td.waku');
      if (wakuCell.length) {
        const rowspanAttr = wakuCell.attr('rowspan');
        remainingRowspan = rowspanAttr ? parseInt(rowspanAttr) : 1;
        
        const wakuImg = wakuCell.find('img');
        const wakuSrc = wakuImg.attr('src') || '';
        const frameMatch = wakuSrc.match(/waku\/(\d+)\.png/);
        currentFrame = frameMatch ? parseInt(frameMatch[1]) : 0;
        console.log(`Row ${index}: New frame ${currentFrame} (rowspan: ${remainingRowspan})`);
      }

      if (currentFrame === 0) {
        console.log(`Row ${index}: Warning: Failed to get frame number for horse ${horseId}`);
        return;
      }

      // 馬名とオッズの取得
      const horseName = row.find('td.horse a').text().trim();
      const isCanceled = row.find('td.odds_tan_cancel').length > 0;
      
      console.log(`Processing horse: ${horseName} (ID: ${horseId}, Frame: ${currentFrame})`);
      console.log(`Canceled status: ${isCanceled}`);
      console.log(`HTML for odds cell:`, row.find('td.odds_tan, td.odds_tan_cancel').html());

      let tanOdds = NaN;
      if (!isCanceled) {
        const tanOddsText = row.find('td.odds_tan').text().trim().replace(/,/g, '');
        tanOdds = parseFloat(tanOddsText);
        console.log(`Tan odds: ${tanOddsText} -> ${tanOdds}`);
      }

      const fukuCell = row.find('td.odds_fuku');
      const fukuText = fukuCell.text().trim().split('-');
      const fukuMinText = fukuText[0].trim();
      const fukuMaxText = fukuText[1]?.trim() || fukuMinText;
      const fukuOddsMin = parseFloat(fukuMinText);
      const fukuOddsMax = parseFloat(fukuMaxText);

      // データの追加
      const horseData = {
        horseId,
        horseName,
        frame: currentFrame,
        number: horseId,
        tanOdds: isCanceled ? -1 : tanOdds,
        fukuOddsMin: isCanceled ? 0 : fukuOddsMin,
        fukuOddsMax: isCanceled ? 0 : fukuOddsMax,
        timestamp: new Date(),
        raceId,
        status: isCanceled ? 'scratched' : 'running'
      };

      console.log('Adding horse data:', horseData);
      oddsData.push(horseData);
      processedHorseIds.add(horseId);
    });

    console.log(`Parsed ${oddsData.length} horses for race ${raceId}`);
    console.log('Final odds data:', oddsData);
    return oddsData;
  }

  private async parseWakurenOdds(html: string, raceId: number): Promise<WakurenOddsData[]> {
    const $ = cheerio.load(html);
    const wakurenOddsData: WakurenOddsData[] = [];

    // 全ての枠連テーブルを処理
    $('table.basic.narrow-xy.waku').each((_, table) => {
      const $table = $(table);
      
      // テーブルのcaptionから軸となる枠番を取得
      const captionClass = $table.find('caption').attr('class') || '';
      const frame1 = parseInt(captionClass.replace('waku', ''));
      
      console.log(`Processing wakuren odds for frame1: ${frame1}`);

      // 各行を処理
      $table.find('tr').each((_, row) => {
        const $row = $(row);
        const frame2Text = $row.find('th').first().text().trim();
        const frame2 = parseInt(frame2Text);

        if (!isNaN(frame2)) {
          const oddsText = $row.find('td').first().text().trim();
          if (oddsText && oddsText !== '-') {
            const odds = parseFloat(oddsText.replace(/,/g, ''));
            
            if (!isNaN(odds)) {
              wakurenOddsData.push({
                frame1,
                frame2,
                odds,
                timestamp: new Date(),
                raceId
              });
            }
          }
        }
      });
    });

    console.log(`Collected total ${wakurenOddsData.length} wakuren odds combinations`);
    return wakurenOddsData;
  }

  private async parseUmarenOdds(html: string, raceId: number): Promise<UmarenOddsData[]> {
    const $ = cheerio.load(html);
    const umarenOddsData: UmarenOddsData[] = [];

    // 全ての馬連テーブルを処理
    $('table.basic.narrow-xy.umaren').each((_, table) => {
      const $table = $(table);
      
      // テーブルのcaptionから軸となる馬番を取得
      const captionText = $table.find('caption').text().trim();
      const horse1 = parseInt(captionText); // 数値のみを取得
      
      if (isNaN(horse1)) {
        console.warn('Failed to parse horse1 number from caption:', captionText);
        return;
      }

      // 各行を処理
      $table.find('tbody tr').each((_, row) => {
        const $row = $(row);
        const horse2Text = $row.find('th').first().text().trim();
        const horse2 = parseInt(horse2Text);

        if (!isNaN(horse2)) {
          const oddsText = $row.find('td').first().text().trim();
          if (oddsText && oddsText !== '-') {
            const odds = parseFloat(oddsText.replace(/,/g, ''));
            
            if (!isNaN(odds)) {
              umarenOddsData.push({
                horse1,
                horse2,
                odds,
                timestamp: new Date(),
                raceId
              });
            }
          }
        }
      });
    });

    console.log(`Collected total ${umarenOddsData.length} umaren odds combinations`);
    return umarenOddsData;
  }

  // パーサー関数の実装
  private async parseWideOdds(html: string, raceId: number): Promise<WideOddsData[]> {
    const $ = cheerio.load(html);
    const wideOddsData: WideOddsData[] = [];

    // 全てのワイドテーブルを処理
    $('table.basic.narrow-xy.wide').each((_, table) => {
      const $table = $(table);
      
      // テーブルのcaptionから軸となる馬番を取得
      const captionText = $table.find('caption').text().trim();
      const horse1 = parseInt(captionText);
      
      if (isNaN(horse1)) {
        console.warn('Failed to parse horse1 number from caption:', captionText);
        return;
      }

      // 各行を処理
      $table.find('tbody tr').each((_, row) => {
        const $row = $(row);
        const horse2Text = $row.find('th').first().text().trim();
        const horse2 = parseInt(horse2Text);

        if (!isNaN(horse2)) {
          // span.minとspan.maxから値を取得
          const $odds = $row.find('td.odds');
          const oddsMinText = $odds.find('span.min').text().trim();
          const oddsMaxText = $odds.find('span.max').text().trim();
          
          if (oddsMinText && oddsMaxText) {
            const oddsMin = parseFloat(oddsMinText.replace(/,/g, ''));
            const oddsMax = parseFloat(oddsMaxText.replace(/,/g, ''));
            
            if (!isNaN(oddsMin) && !isNaN(oddsMax)) {
              wideOddsData.push({
                horse1,
                horse2,
                oddsMin,
                oddsMax,
                timestamp: new Date(),
                raceId
              });
            }
          }
        }
      });
    });

    console.log(`Collected total ${wideOddsData.length} wide odds combinations`);
    return wideOddsData;
  }

  // パーサー関数の実装
  private async parseUmatanOdds(html: string, raceId: number): Promise<UmatanOddsData[]> {
    const $ = cheerio.load(html);
    const umatanOddsData: UmatanOddsData[] = [];

    // 全ての馬単テーブルを処理
    $('table.basic.narrow-xy.umatan').each((_, table) => {
      const $table = $(table);
      
      // テーブルのcaptionから1着となる馬番を取得
      const captionText = $table.find('caption').text().trim();
      const horse1 = parseInt(captionText);
      
      if (isNaN(horse1)) {
        console.warn('Failed to parse horse1 number from caption:', captionText);
        return;
      }

      // 各行を処理
      $table.find('tbody tr').each((_, row) => {
        const $row = $(row);
        const horse2Text = $row.find('th').first().text().trim();
        const horse2 = parseInt(horse2Text);

        if (!isNaN(horse2)) {
          const oddsText = $row.find('td').first().text().trim();
          if (oddsText && oddsText !== '-') {
            const odds = parseFloat(oddsText.replace(/,/g, ''));
            
            if (!isNaN(odds)) {
              umatanOddsData.push({
                horse1,  // 1着となる馬
                horse2,  // 2着となる馬
                odds,
                timestamp: new Date(),
                raceId
              });
            }
          }
        }
      });
    });

    console.log(`Collected total ${umatanOddsData.length} umatan odds combinations`);
    return umatanOddsData;
  }

  // パーサー関数の実装
  private async parseFuku3Odds(html: string, raceId: number): Promise<Fuku3OddsData[]> {
    const $ = cheerio.load(html);
    const fuku3OddsData: Fuku3OddsData[] = [];

    // 全ての3連複テーブルを処理
    $('table.basic.narrow-xy.fuku3').each((_, table) => {
      const $table = $(table);
      
      // テーブルのcaptionから最初の2頭の馬番を取得 (例: "1-2")
      const captionText = $table.find('caption').text().trim();
      const [horse1, horse2] = captionText.split('-').map(num => parseInt(num));
      
      if (isNaN(horse1) || isNaN(horse2)) {
        console.warn('Failed to parse horses from caption:', captionText);
        return;
      }

      // 各行を処理
      $table.find('tbody tr').each((_, row) => {
        const $row = $(row);
        const horse3Text = $row.find('th').first().text().trim();
        const horse3 = parseInt(horse3Text);

        if (!isNaN(horse3)) {
          const oddsText = $row.find('td').first().text().trim();
          if (oddsText && oddsText !== '-') {
            const odds = parseFloat(oddsText.replace(/,/g, ''));
            
            if (!isNaN(odds)) {
              fuku3OddsData.push({
                horse1,
                horse2,
                horse3,
                odds,
                timestamp: new Date(),
                raceId
              });
            }
          }
        }
      });
    });

    console.log(`Collected total ${fuku3OddsData.length} fuku3 odds combinations`);
    return fuku3OddsData;
  }

  // パーサー関数の実装
  private async parseTan3Odds(html: string, raceId: number): Promise<Tan3OddsData[]> {
    const $ = cheerio.load(html);
    const tan3OddsData: Tan3OddsData[] = [];

    // 各馬の3連単テーブルを処理
    $('table.basic.narrow-xy.tan3').each((_, table) => {
      const $table = $(table);
      
      // テーブルの親要素から1着と2着の馬番を取得
      const $container = $table.closest('li');
      const $pLines = $container.find('div.p_line');
      
      // 1着となる馬番を取得
      const horse1Text = $pLines.eq(0).find('div.num').text().trim();
      const horse1 = parseInt(horse1Text);
      
      // 2着となる馬番を取得
      const horse2Text = $pLines.eq(1).find('div.num').text().trim();
      const horse2 = parseInt(horse2Text);
      
      if (isNaN(horse1) || isNaN(horse2)) {
        console.warn('Failed to parse horse numbers:', { horse1Text, horse2Text });
        return;
      }

      // 各行を処理（3着となる馬）
      $table.find('tbody tr').each((_, row) => {
        const $row = $(row);
        const horse3Text = $row.find('th[scope="row"]').text().trim();
        const horse3 = parseInt(horse3Text);

        if (!isNaN(horse3)) {
          const oddsText = $row.find('td').first().text().trim();
          if (oddsText && oddsText !== '-') {
            const odds = parseFloat(oddsText.replace(/,/g, ''));
            
            if (!isNaN(odds)) {
              tan3OddsData.push({
                horse1,  // 1着となる馬
                horse2,  // 2着となる馬
                horse3,  // 3着となる馬
                odds,
                timestamp: new Date(),
                raceId
              });
            }
          }
        }
      });
    });

    console.log(`Collected total ${tan3OddsData.length} tan3 odds combinations`);
    return tan3OddsData;
  }

  async saveOddsHistory(oddsData: OddsData[]) {
    try {
      // バッチサイズを設定
      const BATCH_SIZE = BATCH_SIZES.tanpuku;
      
      // 単勝オッズと複勝オッズを別々のバッチで処理
      const tanOddsInserts = oddsData.map(odds => ({
        horseId: odds.horseId,
        odds: odds.tanOdds.toString(),
        timestamp: odds.timestamp,
        raceId: odds.raceId
      }));
      
      const fukuOddsUpserts = [];
      
      for (const odds of oddsData) {
        // 複勝オッズを更新用に準備
        fukuOddsUpserts.push({
          horseId: odds.horseId,
          oddsMin: odds.fukuOddsMin.toString(),
          oddsMax: odds.fukuOddsMax.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
      
      // 単勝オッズをバッチで挿入
      for (let i = 0; i < tanOddsInserts.length; i += BATCH_SIZE) {
        const batch = tanOddsInserts.slice(i, i + BATCH_SIZE);
        await db.insert(tanOddsHistory).values(batch);
      }
      
      // 複勝オッズをバッチで更新
      // 既存のデータを一括取得
      const raceId = oddsData[0].raceId;
      const existingFukuOdds = await db.query.fukuOdds.findMany({
        where: eq(fukuOdds.raceId, raceId)
      });
      
      const existingMap = new Map(
        existingFukuOdds.map(odds => [odds.horseId, odds])
      );
      
      const updates = [];
      const inserts = [];
      
      for (const odds of fukuOddsUpserts) {
        const existing = existingMap.get(odds.horseId);
        if (existing) {
          updates.push({
            id: existing.id,
            ...odds
          });
        } else {
          inserts.push(odds);
        }
      }
      
      // バッチ更新
      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(update => {
            if (!update.id) return Promise.resolve();
            return db.update(fukuOdds)
              .set({
                oddsMin: update.oddsMin,
                oddsMax: update.oddsMax,
                timestamp: update.timestamp
              })
              .where(eq(fukuOdds.id, update.id));
          })
        );
      }
      
      // バッチ挿入
      for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
        const batch = inserts.slice(i, i + BATCH_SIZE);
        if (batch.length > 0) {
          await db.insert(fukuOdds).values(batch);
        }
      }
      
      console.log(`Saved odds for ${oddsData.length} horses`);
    } catch (error) {
      console.error('Error saving odds:', error);
      throw error;
    }
  }

  async updateWakurenOdds(oddsDataArray: WakurenOddsData[]) {
    const BATCH_SIZE = BATCH_SIZES.wakuren;
    
    const existingOdds = await db.query.wakurenOdds.findMany({
      where: eq(wakurenOdds.raceId, oddsDataArray[0].raceId)
    });
    
    const existingMap = new Map(
      existingOdds.map(odds => [
        `${odds.frame1}-${odds.frame2}`,
        odds
      ])
    );

    const updates: typeof wakurenOdds.$inferInsert[] = [];
    const inserts: typeof wakurenOdds.$inferInsert[] = [];

    for (const odds of oddsDataArray) {
      const key = `${odds.frame1}-${odds.frame2}`;
      const existing = existingMap.get(key);

      if (existing) {
        updates.push({
          id: existing.id,
          frame1: odds.frame1,
          frame2: odds.frame2,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      } else {
        inserts.push({
          frame1: odds.frame1,
          frame2: odds.frame2,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(update => {
          if (!update.id) return Promise.resolve();
          return db.update(wakurenOdds)
            .set({
              odds: update.odds,
              timestamp: update.timestamp
            })
            .where(eq(wakurenOdds.id, update.id));
        })
      );
    }

    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      await db.insert(wakurenOdds).values(batch);
    }
  }

  async updateUmarenOdds(oddsDataArray: UmarenOddsData[]) {
    const BATCH_SIZE = BATCH_SIZES.umaren;
    
    const existingOdds = await db.query.umarenOdds.findMany({
      where: eq(umarenOdds.raceId, oddsDataArray[0].raceId)
    });
    
    const existingMap = new Map(
      existingOdds.map(odds => [
        `${odds.horse1}-${odds.horse2}`,
        odds
      ])
    );

    const updates: typeof umarenOdds.$inferInsert[] = [];
    const inserts: typeof umarenOdds.$inferInsert[] = [];

    for (const odds of oddsDataArray) {
      const key = `${odds.horse1}-${odds.horse2}`;
      const existing = existingMap.get(key);

      if (existing) {
        updates.push({
          id: existing.id,
          horse1: odds.horse1,
          horse2: odds.horse2,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      } else {
        inserts.push({
          horse1: odds.horse1,
          horse2: odds.horse2,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(update => {
          if (!update.id) return Promise.resolve();
          return db.update(umarenOdds)
            .set({
              odds: update.odds,
              timestamp: update.timestamp
            })
            .where(eq(umarenOdds.id, update.id));
        })
      );
    }

    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      await db.insert(umarenOdds).values(batch);
    }
  }

  async updateWideOdds(oddsDataArray: WideOddsData[]) {
    const BATCH_SIZE = BATCH_SIZES.wide;
    
    const existingOdds = await db.query.wideOdds.findMany({
      where: eq(wideOdds.raceId, oddsDataArray[0].raceId)
    });
    
    const existingMap = new Map(
      existingOdds.map(odds => [
        `${odds.horse1}-${odds.horse2}`,
        odds
      ])
    );

    const updates: typeof wideOdds.$inferInsert[] = [];
    const inserts: typeof wideOdds.$inferInsert[] = [];

    for (const odds of oddsDataArray) {
      const key = `${odds.horse1}-${odds.horse2}`;
      const existing = existingMap.get(key);

      if (existing) {
        updates.push({
          id: existing.id,
          horse1: odds.horse1,
          horse2: odds.horse2,
          oddsMin: odds.oddsMin.toString(),
          oddsMax: odds.oddsMax.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      } else {
        inserts.push({
          horse1: odds.horse1,
          horse2: odds.horse2,
          oddsMin: odds.oddsMin.toString(),
          oddsMax: odds.oddsMax.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(update => {
          if (!update.id) return Promise.resolve();
          return db.update(wideOdds)
            .set({
              oddsMin: update.oddsMin,
              oddsMax: update.oddsMax,
              timestamp: update.timestamp
            })
            .where(eq(wideOdds.id, update.id));
        })
      );
    }

    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      await db.insert(wideOdds).values(batch);
    }
  }

  async updateUmatanOdds(oddsDataArray: UmatanOddsData[]) {
    const BATCH_SIZE = BATCH_SIZES.umatan;
    
    const existingOdds = await db.query.umatanOdds.findMany({
      where: eq(umatanOdds.raceId, oddsDataArray[0].raceId)
    });
    
    const existingMap = new Map(
      existingOdds.map(odds => [
        `${odds.horse1}-${odds.horse2}`,
        odds
      ])
    );

    const updates: typeof umatanOdds.$inferInsert[] = [];
    const inserts: typeof umatanOdds.$inferInsert[] = [];

    for (const odds of oddsDataArray) {
      const key = `${odds.horse1}-${odds.horse2}`;
      const existing = existingMap.get(key);

      if (existing) {
        updates.push({
          id: existing.id,
          horse1: odds.horse1,
          horse2: odds.horse2,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      } else {
        inserts.push({
          horse1: odds.horse1,
          horse2: odds.horse2,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(update => {
          if (!update.id) return Promise.resolve();
          return db.update(umatanOdds)
            .set({
              odds: update.odds,
              timestamp: update.timestamp
            })
            .where(eq(umatanOdds.id, update.id));
        })
      );
    }

    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      await db.insert(umatanOdds).values(batch);
    }
  }

  async updateFuku3Odds(oddsDataArray: Fuku3OddsData[]) {
    const BATCH_SIZE = BATCH_SIZES.fuku3;
    
    const existingOdds = await db.query.fuku3Odds.findMany({
      where: eq(fuku3Odds.raceId, oddsDataArray[0].raceId)
    });
    
    const existingMap = new Map(
      existingOdds.map(odds => {
        const horses = [odds.horse1, odds.horse2, odds.horse3].sort((a, b) => a - b);
        return [`${horses[0]}-${horses[1]}-${horses[2]}`, odds];
      })
    );

    const updates: typeof fuku3Odds.$inferInsert[] = [];
    const inserts: typeof fuku3Odds.$inferInsert[] = [];

    for (const odds of oddsDataArray) {
      const horses = [odds.horse1, odds.horse2, odds.horse3].sort((a, b) => a - b);
      const key = `${horses[0]}-${horses[1]}-${horses[2]}`;
      const existing = existingMap.get(key);

      if (existing) {
        updates.push({
          id: existing.id,
          horse1: horses[0],
          horse2: horses[1],
          horse3: horses[2],
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      } else {
        inserts.push({
          horse1: horses[0],
          horse2: horses[1],
          horse3: horses[2],
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(update => {
          if (!update.id) return Promise.resolve();
          return db.update(fuku3Odds)
            .set({
              odds: update.odds,
              timestamp: update.timestamp
            })
            .where(eq(fuku3Odds.id, update.id));
        })
      );
    }

    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      await db.insert(fuku3Odds).values(batch);
    }
  }

  async updateTan3Odds(oddsDataArray: Tan3OddsData[]) {
    // バッチサイズの設定
    const BATCH_SIZE = BATCH_SIZES.tan3;
    
    // 既存データの一括取得
    const existingOdds = await db.query.tan3Odds.findMany({
      where: eq(tan3Odds.raceId, oddsDataArray[0].raceId)
    });
    
    // 既存データをマップ化して高速なルックアップを実現
    const existingMap = new Map(
      existingOdds.map(odds => [
        `${odds.horse1}-${odds.horse2}-${odds.horse3}`,
        odds
      ])
    );

    // 更新と挿入のバッチを準備
    const updates: typeof tan3Odds.$inferInsert[] = [];
    const inserts: typeof tan3Odds.$inferInsert[] = [];

    // データを振り分け
    for (const odds of oddsDataArray) {
      const key = `${odds.horse1}-${odds.horse2}-${odds.horse3}`;
      const existing = existingMap.get(key);

      if (existing) {
        updates.push({
          id: existing.id,
          horse1: odds.horse1,
          horse2: odds.horse2,
          horse3: odds.horse3,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      } else {
        inserts.push({
          horse1: odds.horse1,
          horse2: odds.horse2,
          horse3: odds.horse3,
          odds: odds.odds.toString(),
          timestamp: odds.timestamp,
          raceId: odds.raceId
        });
      }
    }

    // バッチ処理の実行
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(update => {
          if (!update.id) return Promise.resolve(); // idがない場合はスキップ
          return db.update(tan3Odds)
            .set({
              odds: update.odds,
              timestamp: update.timestamp
            })
            .where(eq(tan3Odds.id, update.id));
        })
      );
    }

    // 一括挿入の実行
    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      await db.insert(tan3Odds).values(batch);
    }
  }

  async startPeriodicCollection(intervalMinutes: number = 5) {
    setInterval(async () => {
      const activeRaces = await db.select()
        .from(races)
        .where(eq(races.status, 'upcoming'));

      for (const race of activeRaces) {
        for (const betType of Object.keys(this.betTypes)) {
          try {
            const oddsData = await this.collectOddsForBetType(race.id, betType);
            if (oddsData.length > 0) {
              if (betType === 'wakuren') {
                await this.updateWakurenOdds(oddsData);
              } else if (betType === 'umaren') {
                await this.updateUmarenOdds(oddsData);
              } else if (betType === 'wide') {
                await this.updateWideOdds(oddsData);
              } else if (betType === 'umatan') {
                await this.updateUmatanOdds(oddsData);
              } else {
                await this.saveOddsHistory(oddsData);
              }
            }
          } catch (error) {
            console.error(`Error collecting ${betType} odds for race ${race.id}:`, error);
          }
        }
      }
    }, intervalMinutes * 60 * 1000);
  }

  async cleanup() {
    // コンテキストプールをクリーンアップ
    for (const item of this.contextPool) {
      try {
        await item.context.close();
      } catch (error) {
        console.error('Error closing context during cleanup:', error);
      }
    }
    this.contextPool = [];
    
    // ブラウザは外部から渡されたものなので、ここでは閉じない
    this.browser = null;
  }
}

// place_mappingの定義を追加
const placeMapping: { [key: string]: string } = {
  "01": "札幌",
  "02": "函館",
  "03": "福島",
  "04": "新潟",
  "05": "東京",
  "06": "中山",
  "07": "中京",
  "08": "京都",
  "09": "阪神",
  "10": "小倉"
};