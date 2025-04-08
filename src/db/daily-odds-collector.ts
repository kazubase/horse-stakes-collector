/// <reference types="node-schedule" />

import 'dotenv/config';
import { OddsCollector } from './odds-collector.js';
import { db, schema } from './index.js';
import { races, horses, tanOddsHistory, fukuOdds, wakurenOdds, umarenOdds, wideOdds, umatanOdds, fuku3Odds, tan3Odds } from './schema.js';
import { eq, and } from 'drizzle-orm';
import { Browser, Page, chromium } from 'playwright';
import * as cheerio from 'cheerio';
import schedule from 'node-schedule';
import url from 'url';
import { sql } from 'drizzle-orm';
import { Race } from './schema.js';

interface RaceInfo {
  id: number;
  name: string;
  venue: string;
  startTime: Date;
  isGrade: boolean;
}

class DailyOddsCollector {
  private browser: Browser | null = null;
  private collector: OddsCollector;
  public activeJobs: Map<number, schedule.Job> = new Map();
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 5000; // 5秒
  private lastBrowserReset: Date = new Date();
  private readonly BROWSER_RESET_INTERVAL = 12 * 60 * 60 * 1000; // 12時間ごとにブラウザをリセット
  
  // 並行処理を制御するためのセマフォ
  private collectingSemaphore = {
    maxConcurrent: 3, // 最大同時実行数
    running: 0,
    queue: [] as Array<() => Promise<void>>,
    
    async acquire() {
      if (this.running < this.maxConcurrent) {
        this.running++;
        return true;
      }
      
      return new Promise<boolean>((resolve) => {
        this.queue.push(async () => {
          this.running++;
          resolve(true);
        });
      });
    },
    
    release() {
      this.running--;
      if (this.queue.length > 0 && this.running < this.maxConcurrent) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  };
  
  // ブラウザの状態を追跡
  private browserState = {
    isResetting: false,
    lastError: null as Error | null,
    errorCount: 0,
    maxErrors: 5, // このエラー数を超えると強制リセット
    
    recordError(error: Error) {
      this.lastError = error;
      this.errorCount++;
      return this.errorCount;
    },
    
    resetErrorCount() {
      this.errorCount = 0;
      this.lastError = null;
    }
  };

  constructor() {
    this.collector = new OddsCollector();
  }

  async initialize() {
    try {
      // ブラウザが見つからない場合に備えて、インストールを試みる
      try {
        console.log('Checking for Playwright browser installation...');
        const fs = await import('fs');
        const path = await import('path');
        const { execSync } = await import('child_process');
        
        // Heroku環境でのChromiumパスを確認
        const possiblePaths = [
          // Puppeteerビルドパックが提供するパス
          '/app/.apt/opt/google/chrome/chrome',
          '/app/.apt/usr/bin/google-chrome-stable',
          '/app/.heroku/google-chrome/bin/chrome',
          // Playwrightがインストールする可能性のあるパス
          '/app/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
          '/app/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell',
          '/app/node_modules/.cache/ms-playwright/chromium-1148/chrome-linux/chrome'
        ];
        
        let browserExists = false;
        for (const chromePath of possiblePaths) {
          console.log('Checking path:', chromePath);
          if (fs.existsSync(chromePath)) {
            console.log('Browser executable found at:', chromePath);
            browserExists = true;
            process.env.CHROME_BIN = chromePath;
            break;
          }
        }
        
        if (!browserExists) {
          console.log('Browser executable not found, attempting to install...');
          try {
            // Puppeteerビルドパックが提供するChromiumを探す
            const chromePaths = execSync('find /app -name "chrome" -type f 2>/dev/null || true', { encoding: 'utf8' });
            console.log('Found Chrome paths:', chromePaths);
            
            const chromePathLines = chromePaths.split('\n').filter(Boolean);
            if (chromePathLines.length > 0) {
              process.env.CHROME_BIN = chromePathLines[0];
              console.log('Using Chrome at:', process.env.CHROME_BIN);
              browserExists = true;
            } else {
              // Chromiumをインストール
              execSync('PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium', { stdio: 'inherit' });
              console.log('Browser installation completed');
            }
          } catch (e) {
            console.log('Error during Chrome search or installation:', e);
            // 最後の手段としてPlaywrightのブラウザをインストール
            try {
              execSync('npx playwright install chromium', { stdio: 'inherit' });
              console.log('Alternative browser installation completed');
            } catch (altError) {
              console.log('Alternative installation also failed:', altError);
            }
          }
          
          // インストール後に再度パスをチェック
          for (const chromePath of possiblePaths) {
            if (fs.existsSync(chromePath)) {
              console.log('After installation, browser found at:', chromePath);
              process.env.CHROME_BIN = chromePath;
              browserExists = true;
              break;
            }
          }
          
          // それでも見つからない場合は、システム全体を検索
          if (!browserExists) {
            try {
              const chromePaths = execSync('find /app -name "chrome" -type f 2>/dev/null || true', { encoding: 'utf8' });
              const chromePathLines = chromePaths.split('\n').filter(Boolean);
              if (chromePathLines.length > 0) {
                process.env.CHROME_BIN = chromePathLines[0];
                console.log('Found Chrome after system search at:', process.env.CHROME_BIN);
                browserExists = true;
              }
            } catch (e) {
              console.log('System search failed:', e);
            }
          }
        }
      } catch (installError) {
        console.warn('Failed to check/install browser:', installError);
      }
      
      // ブラウザパスが設定されていない場合、Playwrightにデフォルトを使用させる
      console.log('Final Chrome path:', process.env.CHROME_BIN || 'Using Playwright default');
      
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
      
      // ブラウザインスタンスを渡して初期化
      await this.collector.initialize(this.browser);
      this.lastBrowserReset = new Date();
      console.log('Browser initialized successfully at:', this.lastBrowserReset.toISOString());
    } catch (error) {
      console.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  // ブラウザを再初期化する関数
  async resetBrowser() {
    console.log('Resetting browser...');
    
    // 既にリセット中の場合は待機
    if (this.browserState.isResetting) {
      console.log('Browser reset already in progress, waiting...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      return true;
    }
    
    this.browserState.isResetting = true;
    
    try {
      // 既存のブラウザをクリーンアップ
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (error) {
          console.error('Error closing browser during reset:', error);
        } finally {
          this.browser = null;
        }
      }
      
      // コレクターのクリーンアップ
      await this.collector.cleanup();
      
      // 新しいブラウザを初期化
      this.browser = await chromium.launch({ 
        headless: true,
        executablePath: process.env.CHROME_BIN,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer'
        ]
      });
      
      // コレクターを再初期化
      await this.collector.initialize(this.browser);
      this.lastBrowserReset = new Date();
      this.browserState.resetErrorCount(); // エラーカウンターをリセット
      console.log('Browser reset successfully at:', this.lastBrowserReset.toISOString());
      return true;
    } catch (error) {
      console.error('Failed to reset browser:', error);
      this.browser = null;
      return false;
    } finally {
      this.browserState.isResetting = false;
    }
  }

  // 定期的にブラウザをリセットする必要があるかチェック
  private async checkAndResetBrowserIfNeeded() {
    // ブラウザが初期化されていない場合は初期化
    if (!this.browser) {
      console.log('Browser not initialized in checkAndResetBrowserIfNeeded. Initializing...');
      try {
        await this.initialize();
        return true;
      } catch (error) {
        console.error('Failed to initialize browser in checkAndResetBrowserIfNeeded:', error);
        return false;
      }
    }

    try {
      const now = new Date();
      const timeSinceLastReset = now.getTime() - this.lastBrowserReset.getTime();
      
      // エラー回数が閾値を超えた場合も強制リセット
      if (timeSinceLastReset > this.BROWSER_RESET_INTERVAL || this.browserState.errorCount >= this.browserState.maxErrors) {
        if (this.browserState.errorCount >= this.browserState.maxErrors) {
          console.log(`Browser has encountered ${this.browserState.errorCount} errors. Forcing reset...`);
        } else {
          console.log(`Browser has been running for ${timeSinceLastReset / (60 * 60 * 1000)} hours. Resetting...`);
        }
        return await this.resetBrowser();
      }
      return false;
    } catch (error) {
      console.error('Error in checkAndResetBrowserIfNeeded:', error);
      return false;
    }
  }

  // JRAページから当日のレース情報を取得（重賞とテスト対象レースを含む）
  async getTodayGradeRaces(): Promise<RaceInfo[]> {
    // ブラウザが初期化されていない場合は初期化
    if (!this.browser) {
      console.log('Browser not initialized. Initializing...');
      await this.initialize();
    }
    
    // 定期的なブラウザリセットのチェック
    await this.checkAndResetBrowserIfNeeded();
    
    // ブラウザが初期化されていない場合は例外をスロー
    if (!this.browser) {
      throw new Error('Browser initialization failed');
    }
    
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    const raceInfos: RaceInfo[] = [];

    try {
      // JRAトップページからオッズページへ遷移
      await page.goto('https://www.jra.go.jp/');
      await page.waitForLoadState('networkidle');
      
      await page.getByRole('link', { name: 'オッズ', exact: true }).click();
      await page.waitForLoadState('networkidle');

      const html = await page.content();
      const $ = cheerio.load(html);

      // 当日および翌日の開催情報を取得
      const today = new Date();
      const todayStr = `${today.getMonth() + 1}月${today.getDate()}日`;
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      const tomorrowStr = `${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;
      console.log('Looking for races on:', todayStr, 'or', tomorrowStr);

      // 各開催の情報を取得
      const kaisaiElements = $('.thisweek .panel.no-padding.no-border[class*="mt"]');
      console.log('Found kaisai elements:', kaisaiElements.length);

      for (const element of kaisaiElements.toArray()) {
        const $kaisai = $(element);
        const dateHeader = $kaisai.find('.sub_header').text().trim();
        console.log('Date header:', dateHeader);

        // 当日または翌日の開催情報であれば処理する
        if (dateHeader.includes(todayStr) || dateHeader.includes(tomorrowStr)) {
          console.log('Processing kaisai for date:', dateHeader);
          const kaisaiLinks = $kaisai.find('.link_list a');
          console.log('Found kaisai links:', kaisaiLinks.length);

          // ヘッダーの日付に合わせて基準日（baseDate）を設定
          let baseDate: Date;
          if (dateHeader.includes(tomorrowStr)) {
            baseDate = new Date(tomorrow);
          } else {
            baseDate = new Date(today);
          }
          
          for (const link of kaisaiLinks.toArray()) {
            const kaisaiText = $(link).text().trim();
            console.log('Kaisai text:', kaisaiText);
            const [kai, venue, nichi] = kaisaiText.match(/(\d+)回(.+?)(\d+)日/)?.slice(1) || [];
            console.log('Parsed values:', { kai, venue, nichi });
            
            try {
              // 開催ボタンをクリック
              const kaisaiName = `${kai}回${venue}${nichi}日`;
              await page.getByRole('link', { name: kaisaiName }).click();
              await page.waitForLoadState('networkidle');

              // レース一覧から重賞レースを探す
              const raceListHtml = await page.content();
              const $races = cheerio.load(raceListHtml);

              console.log('Checking races for:', kaisaiName);
              const rows = $races('tr').toArray();
              for (const row of rows) {
                const $row = $races(row);
                const $raceName = $row.find('.race_name');
                const $raceNum = $row.find('.race_num');
                const $raceTime = $row.find('.time');
                
                // レース名とグレード情報を取得
                const raceName = $raceName.find('.stakes').text().trim();
                const gradeIcon = $raceName.find('.grade_icon img').attr('src');
                const isGrade = gradeIcon?.includes('icon_grade_s_g');
                
                // レース番号の画像から取得（"11レース" → 11）
                const raceNumber = parseInt($raceNum.find('img').attr('alt')?.replace('レース', '') || '0');
                
                if (isGrade) {
                  // 時刻を日本語形式から変換（例：「15時45分」→ [15, 45]）
                  const timeText = $raceTime.text().trim();
                  console.log('Race time text:', timeText);

                  // 「発走済」の場合はステータス更新
                  if (timeText === '発走済') {
                    const year = baseDate.getFullYear();
                    const venueCode = this.getVenueCode(venue);
                    const raceId = parseInt(
                      `${year}${venueCode}${kai.padStart(2, '0')}${nichi.padStart(2, '0')}${raceNumber.toString().padStart(2, '0')}`
                    );
                    console.log(`Race ${raceName} has already started, updating status to done for ID: ${raceId}`);
                    await db.update(races)
                      .set({ status: 'done' })
                      .where(eq(races.id, raceId));
                    continue;
                  }

                  // baseDate を元にレース開始時刻を設定（ヘッダーの日付が翌日の場合は tomorrow、そうでなければ today）
                  const [hours, minutes] = timeText.replace(/[時分]/g, ':').split(':').map(Number);
                  
                  // 日本時間（JST）でレース時刻を設定
                  const raceTimeJST = new Date(baseDate.getTime());
                  raceTimeJST.setHours(hours, minutes, 0, 0);
                  console.log('Debug - raceTimeJST (before conversion):', raceTimeJST.toISOString());
                  
                  // 重要: JSTの時間をUTCに変換してDBに保存する
                  // JSTからUTCに変換（-9時間）
                  const JST_OFFSET = 9 * 60 * 60 * 1000;
                  const raceTimeUTC = new Date(raceTimeJST.getTime() - JST_OFFSET);
                  console.log('Debug - raceTimeUTC (after conversion):', raceTimeUTC.toISOString());
                  
                  const year = baseDate.getFullYear();
                  const venueCode = this.getVenueCode(venue);
                  const raceId = parseInt(
                    `${year}${venueCode}${kai.padStart(2, '0')}${nichi.padStart(2, '0')}${raceNumber.toString().padStart(2, '0')}`
                  );

                  raceInfos.push({
                    id: raceId,
                    name: raceName || `${venue}${raceNumber}R`,
                    venue,
                    startTime: raceTimeUTC, // UTCで保存
                    isGrade: !!isGrade  
                  });
                  
                  console.log('Found race:', { 
                    raceName, 
                    raceId, 
                    timeText, 
                    raceNumber, 
                    raceTimeJST: raceTimeJST.toISOString(),
                    raceTimeUTC: raceTimeUTC.toISOString() 
                  });
                }
              }

              console.log('Found races for venue:', venue, raceInfos);

              // 開催選択ページに戻る
              await page.goto('https://www.jra.go.jp/keiba/');
              await page.waitForLoadState('networkidle');
              await page.getByRole('link', { name: 'オッズ', exact: true }).click();
              await page.waitForLoadState('networkidle');
            } catch (error) {
              console.error(`Error processing ${kaisaiText}:`, error);
            }
          }
        }
      }

    } finally {
      await context.close();
    }

    console.log('Found grade races:', raceInfos);
    return raceInfos;
  }

  // レース情報をDBに登録
  async registerRace(race: RaceInfo) {
    const existingRace = await db.query.races.findFirst({
      where: eq(races.id, race.id)
    });

    if (!existingRace) {
      await db.insert(races).values({
        id: race.id,
        name: race.name,
        venue: race.venue,
        startTime: race.startTime,
        status: "upcoming"
      });
    }
  }

  // オッズ収集のスケジュール設定
  async scheduleOddsCollection(race: RaceInfo) {
    try {
      // 既存のジョブがあれば削除
      if (this.activeJobs.has(race.id)) {
        const existingJob = this.activeJobs.get(race.id);
        existingJob?.cancel();
        this.activeJobs.delete(race.id);
        this.logWithTimestamp('info', `Cancelled existing job for race ${race.id}`);
      }
    
      // タイムゾーン処理を一貫化
      // 日本時間（JST）での処理を明示的に行う
      const JST_OFFSET = 9 * 60 * 60 * 1000; // 日本時間は UTC+9 (ミリ秒単位)
      
      // デバッグ情報を出力
      console.log('Debug - race.startTime (raw):', race.startTime);
      console.log('Debug - race.startTime (ISO):', race.startTime.toISOString());
      
      // 重要: race.startTimeはUTCとして保存されているが、表示はJSTとして行う
      // UTCのままで処理し、表示時のみJSTに変換する
      const raceStartTimeUTC = new Date(race.startTime);
      console.log('Debug - raceStartTimeUTC:', raceStartTimeUTC.toISOString());
      
      // 収集開始時刻の設定（重賞レースの場合）
      let collectionStartTimeUTC: Date | null = null;
      if (race.isGrade) {
        // 重賞レースの場合、前日9:00 JSTから収集開始
        // 日本時間で計算してからUTCに変換する方法に変更
        
        // 1. レース開始時刻をJSTに変換
        const raceStartTimeJST = new Date(raceStartTimeUTC.getTime() + JST_OFFSET);
        console.log('Debug - raceStartTimeJST:', raceStartTimeJST.toISOString());
        
        // 2. 前日の9:00 JSTを設定
        const collectionStartTimeJST = new Date(raceStartTimeJST);
        collectionStartTimeJST.setDate(collectionStartTimeJST.getDate() - 1);
        collectionStartTimeJST.setHours(9, 0, 0, 0); 
        console.log('Debug - collectionStartTimeJST:', collectionStartTimeJST.toISOString());
        
        // 3. JSTからUTCに変換
        collectionStartTimeUTC = new Date(collectionStartTimeJST.getTime() - JST_OFFSET);
        console.log('Debug - collectionStartTimeUTC:', collectionStartTimeUTC.toISOString());
        
        // UTC時間をJST表示に変換（ログ表示用）
        const jstCollectionStartTime = this.formatJSTTime(collectionStartTimeUTC);
        this.logWithTimestamp('info', 
          `Race ${race.id} is grade. Collection will start at ${jstCollectionStartTime} (JST)`
        );
      }
    
      // レース開始時刻をJST表示に変換
      const jstRaceStartTime = this.formatJSTTime(raceStartTimeUTC);
      this.logWithTimestamp('info', `Setting up schedule for race: ${race.id}, start time: ${jstRaceStartTime} (JST)`);
      
      // 固定のcron式を使用（5分ごとに実行）
      const cronExpression = `0,5,10,15,20,25,30,35,40,45,50,55 * * * *`;
      this.logWithTimestamp('info', `Setting cron schedule for race ${race.id}: ${cronExpression}`);
      
      const job = schedule.scheduleJob(cronExpression, async () => {
        try {
          const nowUTC = new Date();
          console.log('Debug - nowUTC:', nowUTC.toISOString());
          
          // 重賞の場合、収集開始時刻に達していなければスキップする
          if (race.isGrade && collectionStartTimeUTC && nowUTC < collectionStartTimeUTC) {
            const jstNow = this.formatJSTTime(nowUTC);
            const jstCollectionStart = this.formatJSTTime(collectionStartTimeUTC);
            console.log('Debug - Time comparison:', {
              nowUTC: nowUTC.toISOString(),
              collectionStartTimeUTC: collectionStartTimeUTC.toISOString(),
              comparison: nowUTC < collectionStartTimeUTC ? 'nowUTC is earlier' : 'nowUTC is later'
            });
            this.logWithTimestamp('info', 
              `Race ${race.id} is grade. Waiting for collection start time: ${jstCollectionStart} (JST). Current: ${jstNow} (JST)`
            );
            return;
          }
          
          // レース開始までの時間（ミリ秒）
          const timeToRace = raceStartTimeUTC.getTime() - nowUTC.getTime();
          
          // レース開始後5分以内は最終オッズを取得するためにジョブを継続
          // これにより、レース開始直後の最終オッズを確実に取得できる
          const FINAL_ODDS_WINDOW = 5 * 60 * 1000; // 5分間
          
          if (timeToRace > -FINAL_ODDS_WINDOW) {
            // 収集頻度を動的に調整
            let shouldCollect = false;
            
            if (race.isGrade) {
              // 重賞レースの収集頻度
              if (timeToRace <= 30 * 60 * 1000) {
                // レース30分前以内: 5分ごと
                shouldCollect = true;
              } else if (timeToRace <= 3 * 60 * 60 * 1000) {
                // レース3時間前以内: 10分ごと
                shouldCollect = nowUTC.getMinutes() % 10 === 0;
              } else if (timeToRace <= 12 * 60 * 60 * 1000) {
                // レース12時間前以内: 30分ごと
                shouldCollect = nowUTC.getMinutes() % 30 === 0;
              } else {
                // それ以前: 1時間ごと
                shouldCollect = nowUTC.getMinutes() === 0;
              }
            } else {
              // 通常レースの収集頻度
              if (timeToRace <= 30 * 60 * 1000) {
                // レース30分前以内: 10分ごと
                shouldCollect = nowUTC.getMinutes() % 10 === 0;
              } else {
                // それ以前: 30分ごと
                shouldCollect = nowUTC.getMinutes() % 30 === 0;
              }
            }
            
            // レース開始後は必ず収集（最終オッズ取得のため）
            if (timeToRace <= 0) {
              shouldCollect = true;
            }
            
            if (shouldCollect) {
              this.logWithTimestamp('info', `Collecting odds for race ${race.id} (${Math.floor(timeToRace / 60000)} minutes to race)`);
              await this.collectOdds(race.id);
            }
          } else {
            // レース開始から5分以上経過した場合、ジョブをキャンセル
            this.logWithTimestamp('info', `Race ${race.id} has finished more than 5 minutes ago. Cancelling job.`);
            job.cancel();
            this.activeJobs.delete(race.id);
            
            // レースのステータスが更新されていない場合は更新
            const currentRace = await this.withDbRetry(() => 
              db.query.races.findFirst({
                where: eq(races.id, race.id)
              })
            );
            
            if (currentRace && currentRace.status === 'upcoming') {
              this.logWithTimestamp('info', `Updating status to done for race ${race.id}`);
              await this.withDbRetry(() =>
                db.update(races)
                  .set({ status: 'done' })
                  .where(eq(races.id, race.id))
              );
            }
          }
        } catch (error) {
          this.logWithTimestamp('error', `Error in scheduled odds collection for race ${race.id}:`, error);
          // エラーからの回復を試みる
          await this.recoverFromError(`scheduled odds collection for race ${race.id}`);
        }
      });
    
      this.activeJobs.set(race.id, job);
      
      // 初回実行: 即時オッズ収集を実施する
      const nowUTC = new Date();
      console.log('Debug - Initial check nowUTC:', nowUTC.toISOString());
      if (collectionStartTimeUTC) {
        console.log('Debug - Initial check collectionStartTimeUTC:', collectionStartTimeUTC.toISOString());
        console.log('Debug - Initial check comparison:', nowUTC >= collectionStartTimeUTC ? 'nowUTC is later or equal' : 'nowUTC is earlier');
      }
      
      // 重賞レースの場合、収集開始時刻に達していれば即時収集
      if (!race.isGrade || (collectionStartTimeUTC && nowUTC >= collectionStartTimeUTC)) {
        this.logWithTimestamp('info', `Initial collection for race ${race.id}`);
        await this.collectOdds(race.id);
      } else if (race.isGrade && collectionStartTimeUTC) {
        // 収集開始時刻に達していない場合、次の収集時刻をログに出力
        const jstNow = this.formatJSTTime(nowUTC);
        const jstCollectionStart = this.formatJSTTime(collectionStartTimeUTC);
        this.logWithTimestamp('info', 
          `Race ${race.id} is grade. Initial collection skipped. Will start at ${jstCollectionStart} (JST). Current: ${jstNow} (JST)`
        );
      }
      
      return true;
    } catch (error) {
      this.logWithTimestamp('error', `Failed to schedule odds collection for race ${race.id}:`, error);
      return false;
    }
  }

  // ジョブ管理を強化するためのヘルパーメソッド
  public checkAndRestoreJobs() {
    try {
      this.logWithTimestamp('info', `Checking active jobs. Current count: ${this.activeJobs.size}`);
      
      // アクティブなジョブの状態を確認
      // MapIteratorのリンターエラーを修正するため、Array.fromでエントリを配列に変換
      Array.from(this.activeJobs.entries()).forEach(([raceId, job]) => {
        if (!job.nextInvocation()) {
          this.logWithTimestamp('warn', `Job for race ${raceId} has no next invocation. It may be cancelled or invalid.`);
          this.activeJobs.delete(raceId);
        }
      });
      
      return true;
    } catch (error) {
      this.logWithTimestamp('error', 'Error checking active jobs:', error);
      return false;
    }
  }

  // データベース接続のリトライ処理を追加
  public async withDbRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let i = 0; i < this.MAX_RETRIES; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === this.MAX_RETRIES - 1) throw error;
        
        console.log(`Database operation failed, retrying in ${this.RETRY_DELAY}ms...`, error);
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ジョブ管理のためのヘルパーメソッド
  public getActiveJobsCount(): number {
    return this.activeJobs.size;
  }

  // 特定のレースIDに対するジョブが存在するか確認
  public hasActiveJob(raceId: number): boolean {
    return this.activeJobs.has(raceId);
  }

  // upcomingレースに対するジョブの状態を確認し、必要に応じて復元する
  public async checkAndRestoreRaceJobs(): Promise<number> {
    try {
      // アクティブなジョブの数を確認
      this.logWithTimestamp('info', `Checking active jobs. Current count: ${this.getActiveJobsCount()}`);
      
      // 今後のレースを取得
      const upcomingRaces = await this.withDbRetry(() => 
        db.query.races.findMany({
          where: eq(races.status, 'upcoming')
        })
      );
      
      this.logWithTimestamp('info', `Found ${upcomingRaces.length} upcoming races`);
      
      let restoredCount = 0;
      
      // 各レースに対してジョブが存在するか確認し、なければ作成
      for (const race of upcomingRaces) {
        if (this.hasActiveJob(race.id)) {
          this.logWithTimestamp('info', `Race ${race.id} already has an active job. Next invocation at ${this.activeJobs.get(race.id)?.nextInvocation()?.toISOString()}`);
          continue;
        }
        
        // 固定のcron式を使用（5分ごとに実行）
        const cronExpression = `0,5,10,15,20,25,30,35,40,45,50,55 * * * *`;
        this.logWithTimestamp('info', `Restoring job for race ${race.id} with cron schedule: ${cronExpression}`);
        
        // RaceInfoオブジェクトを作成
        const raceInfo: RaceInfo = {
          id: race.id,
          name: race.name,
          venue: race.venue,
          startTime: race.startTime,
          isGrade: race.name.includes('G1') || race.name.includes('G2') || race.name.includes('G3')
        };
        
        // ジョブをスケジュール
        await this.scheduleOddsCollection(raceInfo);
        restoredCount++;
      }
      
      return restoredCount;
    } catch (error) {
      this.logWithTimestamp('error', 'Error in checkAndRestoreRaceJobs:', error);
      return 0;
    }
  }

  // ヘルスチェック機能を追加
  public async healthCheck(): Promise<boolean> {
    if (!this.browser) {
      console.log('Browser not initialized during health check. Initializing...');
      try {
        await this.initialize();
        return true;
      } catch (error) {
        console.error('Failed to initialize browser during health check:', error);
        return false;
      }
    }

    try {
      // 簡単なテストページにアクセスしてブラウザが正常に動作しているか確認
      const context = await this.browser.newContext();
      const page = await context.newPage();
      await page.goto('https://www.jra.go.jp/');
      await page.waitForLoadState('networkidle');
      await context.close();
      return true;
    } catch (error) {
      console.error('Browser health check failed:', error);
      // ブラウザの再初期化を試みる
      try {
        await this.resetBrowser();
        return true;
      } catch (resetError) {
        console.error('Failed to reset browser after health check failure:', resetError);
        return false;
      }
    }
  }

  // エラー回復機能を追加
  public async recoverFromError(operation: string): Promise<boolean> {
    console.error(`Attempting to recover from error in ${operation}`);
    
    try {
      // ブラウザをリセット
      const resetSuccess = await this.resetBrowser();
      if (!resetSuccess) {
        console.error(`Failed to reset browser during recovery from ${operation}`);
        return false;
      }
      
      // ヘルスチェックを実行
      const healthCheckSuccess = await this.healthCheck();
      if (!healthCheckSuccess) {
        console.error(`Health check failed during recovery from ${operation}`);
        return false;
      }
      
      console.log(`Successfully recovered from error in ${operation}`);
      return true;
    } catch (error) {
      console.error(`Recovery attempt failed for ${operation}:`, error);
      return false;
    }
  }

  // オッズ収集実行の改善
  public async collectOdds(raceId: number) {
    // セマフォを取得
    const semaphoreAcquired = await this.collectingSemaphore.acquire();
    if (!semaphoreAcquired) {
      this.logWithTimestamp('info', `Queued odds collection for race ${raceId} due to concurrency limit`);
      return;
    }
    
    try {
      // 定期的なブラウザリセットのチェック
      await this.checkAndResetBrowserIfNeeded();
      
      // ヘルスチェックを実行
      const healthCheckSuccess = await this.healthCheck();
      if (!healthCheckSuccess) {
        this.logWithTimestamp('error', `Health check failed in collectOdds for race ${raceId}`);
        await this.recoverFromError(`collectOdds for race ${raceId}`);
      }
      
      const race = await this.withDbRetry(() => 
        db.query.races.findFirst({
          where: eq(races.id, raceId)
        })
      );

      if (!race || race.status === 'done') {
        this.collectingSemaphore.release();
        return;
      }

      const nowUTC = new Date();
      const JST_OFFSET = 9 * 60 * 60 * 1000; // 日本時間は UTC+9 (ミリ秒単位)
      
      console.log('Debug - collectOdds - race.startTime:', race.startTime.toISOString());
      
      // レース前日18:00から当日9:00までの間は収集を停止
      // 重要: race.startTimeはUTCとして保存されている
      const raceDateUTC = new Date(race.startTime);
      console.log('Debug - collectOdds - raceDateUTC:', raceDateUTC.toISOString());
      
      const previousDayUTC = new Date(raceDateUTC);
      previousDayUTC.setDate(previousDayUTC.getDate() - 1);
      previousDayUTC.setUTCHours(9, 0, 0, 0); // 18:00 JST = 9:00 UTC
      console.log('Debug - collectOdds - previousDayUTC:', previousDayUTC.toISOString());

      const raceDayUTC = new Date(raceDateUTC);
      raceDayUTC.setUTCHours(0, 0, 0, 0); // 9:00 JST = 0:00 UTC
      console.log('Debug - collectOdds - raceDayUTC:', raceDayUTC.toISOString());

      // 夜間収集停止の条件をコメントアウト
      // if (nowUTC >= previousDayUTC && nowUTC < raceDayUTC) {
      //   this.logWithTimestamp('info', `Skipping odds collection for race ${raceId} during overnight period (18:00-09:00)`);
      //   return;
      // }

      // 時間をJST形式で表示
      const jstNow = this.formatJSTTime(nowUTC);
      const jstRaceStartTime = this.formatJSTTime(raceDateUTC);
      this.logWithTimestamp('info', `Current time: ${jstNow} (JST)`);
      this.logWithTimestamp('info', `Race start time: ${jstRaceStartTime} (JST)`);

      // レース開始時刻を過ぎている場合、最終オッズを取得してからステータスを更新
      // 重要: race.startTimeはUTCとして保存されている
      const raceStartTimeUTC = new Date(race.startTime);
      console.log('Debug - collectOdds - nowUTC:', nowUTC.toISOString());
      console.log('Debug - collectOdds - raceStartTimeUTC:', raceStartTimeUTC.toISOString());
      console.log('Debug - collectOdds - comparison:', raceStartTimeUTC < nowUTC ? 'race has started' : 'race has not started yet');
      
      if (raceStartTimeUTC < nowUTC && race.status === 'upcoming') {
        this.logWithTimestamp('info', `Race ${raceId} has started. Collecting final odds before marking as done.`);
        
        // 最終オッズを取得
        const betTypes = ['tanpuku', 'wakuren', 'umaren', 'wide', 'umatan', 'fuku3', 'tan3'] as const;
        
        // 並行処理を避けるため、各ベットタイプを順次処理
        for (const betType of betTypes) {
          let retryCount = 0;
          while (retryCount < this.MAX_RETRIES) {
            try {
              this.logWithTimestamp('info', `Collecting final ${betType} odds for race ID: ${raceId} (attempt ${retryCount + 1})`);
              const odds = await this.collector.collectOddsForBetType(raceId, betType);
              
              if (odds.length > 0) {
                try {
                  if (betType === 'tanpuku') {
                    await this.handleTanpukuOdds(raceId, odds);
                  } else {
                    await this.handleOtherOdds(betType, odds);
                  }
                  this.logWithTimestamp('info', `Final ${betType} odds data saved successfully`);
                  break;
                } catch (error: any) {
                  // タイムアウトエラーの場合は、このベットタイプが利用できないと判断してスキップ
                  if (error.name === 'TimeoutError') {
                    this.logWithTimestamp('warn', `Timeout occurred while collecting ${betType} odds for race ${raceId}. This bet type may not be available for this race. Skipping.`);
                    break; // このベットタイプのリトライを中止
                  }
                  
                  this.logWithTimestamp('error', `Error collecting final ${betType} odds for race ${raceId} (attempt ${retryCount + 1}):`, error);
                  if (retryCount === this.MAX_RETRIES - 1) {
                    this.logWithTimestamp('error', `Max retries exceeded for final ${betType} odds collection`);
                    break;
                  }
                  retryCount++;
                  await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                }
              }
            } catch (error: any) {
              this.logWithTimestamp('error', `Error in collectOddsForBetType for race ${raceId}, bet type ${betType}:`, error);
              
              // ブラウザエラーを記録
              if (error.message && error.message.includes('browser')) {
                const errorCount = this.browserState.recordError(error);
                if (errorCount >= this.browserState.maxErrors) {
                  this.logWithTimestamp('warn', `Browser error threshold reached. Will reset browser.`);
                  await this.resetBrowser();
                }
              }
              
              retryCount++;
              if (retryCount >= this.MAX_RETRIES) {
                this.logWithTimestamp('error', `Max retries exceeded for ${betType} odds collection`);
                break;
              }
              await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            }
          }
        }
        
        // 最終オッズ取得後にステータスを更新
        await this.withDbRetry(() =>
          db.update(races)
            .set({ status: 'done' })
            .where(eq(races.id, raceId))
        );
        this.logWithTimestamp('info', `Race ${raceId} marked as done after collecting final odds`);
        this.collectingSemaphore.release();
        return;
      }

      this.logWithTimestamp('info', `Collecting odds for race ${raceId}`);
      // betTypesの再宣言を避けるため、新しい名前を使用
      const oddsTypes = ['tanpuku', 'wakuren', 'umaren', 'wide', 'umatan', 'fuku3', 'tan3'] as const;
      
      // 並行処理を避けるため、各ベットタイプを順次処理
      for (const betType of oddsTypes) {
        let retryCount = 0;
        while (retryCount < this.MAX_RETRIES) {
          try {
            this.logWithTimestamp('info', `Collecting ${betType} odds for race ID: ${raceId} (attempt ${retryCount + 1})`);
            const odds = await this.collector.collectOddsForBetType(raceId, betType);
            
            if (odds.length > 0) {
              try {
                if (betType === 'tanpuku') {
                  await this.handleTanpukuOdds(raceId, odds);
                } else {
                  await this.handleOtherOdds(betType, odds);
                }
                this.logWithTimestamp('info', `${betType} odds data saved successfully`);
                break;
              } catch (error: any) {
                // タイムアウトエラーの場合は、このベットタイプが利用できないと判断してスキップ
                if (error.name === 'TimeoutError') {
                  this.logWithTimestamp('warn', `Timeout occurred while collecting ${betType} odds for race ${raceId}. This bet type may not be available for this race. Skipping.`);
                  break; // このベットタイプのリトライを中止
                }
                
                this.logWithTimestamp('error', `Error collecting ${betType} odds for race ${raceId} (attempt ${retryCount + 1}):`, error);
                if (retryCount === this.MAX_RETRIES - 1) {
                  this.logWithTimestamp('error', `Max retries exceeded for ${betType} odds collection`);
                  break;
                }
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
              }
            }
          } catch (error: any) {
            this.logWithTimestamp('error', `Error in collectOddsForBetType for race ${raceId}, bet type ${betType}:`, error);
            
            // ブラウザエラーを記録
            if (error.message && error.message.includes('browser')) {
              const errorCount = this.browserState.recordError(error);
              if (errorCount >= this.browserState.maxErrors) {
                this.logWithTimestamp('warn', `Browser error threshold reached. Will reset browser.`);
                await this.resetBrowser();
              }
            }
            
            retryCount++;
            if (retryCount >= this.MAX_RETRIES) {
              this.logWithTimestamp('error', `Max retries exceeded for ${betType} odds collection`);
              break;
            }
            await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
          }
        }
      }
    } catch (error) {
      this.logWithTimestamp('error', `Error in collectOdds for race ${raceId}:`, error);
      throw error;
    } finally {
      // 必ずセマフォを解放
      this.collectingSemaphore.release();
    }
  }

  // 単複オッズ処理を分離
  private async handleTanpukuOdds(raceId: number, odds: any[]) {
    for (const odd of odds) {
      await this.withDbRetry(async () => {
        const existingHorse = await db.query.horses.findFirst({
          where: and(
            eq(horses.name, odd.horseName),
            eq(horses.raceId, raceId)
          )
        });

        if (!existingHorse) {
          await db.insert(horses).values({
            name: odd.horseName,
            raceId: raceId,
            frame: odd.frame,
            number: odd.number,
            status: odd.odds === '取消' ? 'scratched' : 'running'
          });
        } else if (odd.odds === '取消' && existingHorse.status !== 'scratched') {
          await db.update(horses)
            .set({ status: 'scratched' })
            .where(and(
              eq(horses.name, odd.horseName),
              eq(horses.raceId, raceId)
            ));
        }
      });
    }
    await this.collector.saveOddsHistory(odds);
  }

  // その他のオッズ処理を分離
  private async handleOtherOdds(betType: string, odds: any[]) {
    const updateMethod = {
      wakuren: this.collector.updateWakurenOdds.bind(this.collector),
      umaren: this.collector.updateUmarenOdds.bind(this.collector),
      wide: this.collector.updateWideOdds.bind(this.collector),
      umatan: this.collector.updateUmatanOdds.bind(this.collector),
      fuku3: this.collector.updateFuku3Odds.bind(this.collector),
      tan3: this.collector.updateTan3Odds.bind(this.collector)
    }[betType];

    if (!updateMethod) {
      throw new Error(`Invalid bet type: ${betType}`);
    }

    await this.withDbRetry(() => updateMethod(odds));
  }

  private getVenueCode(venue: string): string {
    const venueMap: { [key: string]: string } = {
      "札幌": "01", "函館": "02", "福島": "03", "新潟": "04",
      "東京": "05", "中山": "06", "中京": "07", "京都": "08",
      "阪神": "09", "小倉": "10"
    };
    return venueMap[venue] || "00";
  }

  async cleanup() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      } finally {
        this.browser = null;
      }
    }
    await this.collector.cleanup();
    Array.from(this.activeJobs.values()).forEach(job => job.cancel());
    this.activeJobs.clear();
  }

  async checkUpcomingRaces() {
    try {
      // ブラウザが初期化されていない場合は初期化
      if (!this.browser) {
        console.log('Browser not initialized in checkUpcomingRaces. Initializing...');
        await this.initialize();
      }
      
      // 定期的なブラウザリセットのチェック
      await this.checkAndResetBrowserIfNeeded();
      
      // ヘルスチェックを実行
      const healthCheckSuccess = await this.healthCheck();
      if (!healthCheckSuccess) {
        this.logWithTimestamp('error', `Health check failed in checkUpcomingRaces`);
        await this.recoverFromError(`checkUpcomingRaces`);
      }
      
      // アクティブなジョブの数を確認
      this.logWithTimestamp('info', `Checking active jobs. Current count: ${this.getActiveJobsCount()}`);
      
      // 今後のレースを取得
      const races = await this.getTodayGradeRaces();
      
      if (races.length === 0) {
        this.logWithTimestamp('info', 'No upcoming races found');
        return;
      }
      
      this.logWithTimestamp('info', `Found ${races.length} upcoming races`);
      
      // 並行処理を制御するためのセマフォを使用
      const processRace = async (race: RaceInfo) => {
        try {
          // 既にジョブが存在する場合はスキップ
          if (this.hasActiveJob(race.id)) {
            this.logWithTimestamp('info', `Race ${race.id} already has an active job. Next invocation at ${this.activeJobs.get(race.id)?.nextInvocation()?.toISOString()}`);
            return;
          }
          
          // レースを登録
          await this.registerRace(race);
          
          // オッズ収集をスケジュール
          await this.scheduleOddsCollection(race);
          
          this.logWithTimestamp('info', `Scheduled odds collection for race ${race.id}`);
        } catch (error) {
          this.logWithTimestamp('error', `Error processing race ${race.id}:`, error);
        }
      };
      
      // 各レースを処理（同時実行数を制限）
      const MAX_CONCURRENT = 3;
      for (let i = 0; i < races.length; i += MAX_CONCURRENT) {
        const batch = races.slice(i, i + MAX_CONCURRENT);
        await Promise.all(batch.map(race => processRace(race)));
        
        // バッチ間に少し間隔を空ける
        if (i + MAX_CONCURRENT < races.length) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      // 既存のジョブを確認して、必要に応じて復元
      await this.checkAndRestoreRaceJobs();
      
    } catch (error) {
      this.logWithTimestamp('error', 'Error in checkUpcomingRaces:', error);
      throw error;
    }
  }

  // 古いレースデータを削除する関数を追加
  private async cleanupOldRaceData() {
    try {
      // 2週間前の日付を計算
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      
      console.log(`Cleaning up race data older than ${twoWeeksAgo.toISOString()}`);

      // 古いレースを取得
      const oldRaces = await db.query.races.findMany({
        where: sql`${races.startTime} < ${twoWeeksAgo}`
      });

      if (oldRaces.length === 0) {
        console.log('No old races to clean up');
        return;
      }

      console.log(`Found ${oldRaces.length} races to clean up`);
      const raceIds = oldRaces.map(race => race.id);

      // トランザクションで関連データを一括削除
      await db.transaction(async (tx) => {
        // 関連テーブルのデータを削除
        await tx.delete(tanOddsHistory).where(sql`${tanOddsHistory.raceId} = ANY(${raceIds})`);
        await tx.delete(fukuOdds).where(sql`${fukuOdds.raceId} = ANY(${raceIds})`);
        await tx.delete(wakurenOdds).where(sql`${wakurenOdds.raceId} = ANY(${raceIds})`);
        await tx.delete(umarenOdds).where(sql`${umarenOdds.raceId} = ANY(${raceIds})`);
        await tx.delete(wideOdds).where(sql`${wideOdds.raceId} = ANY(${raceIds})`);
        await tx.delete(umatanOdds).where(sql`${umatanOdds.raceId} = ANY(${raceIds})`);
        await tx.delete(fuku3Odds).where(sql`${fuku3Odds.raceId} = ANY(${raceIds})`);
        await tx.delete(tan3Odds).where(sql`${tan3Odds.raceId} = ANY(${raceIds})`);
        await tx.delete(horses).where(sql`${horses.raceId} = ANY(${raceIds})`);
        await tx.delete(races).where(sql`${races.id} = ANY(${raceIds})`);
      });

      console.log(`Successfully cleaned up ${oldRaces.length} races and their related data`);
    } catch (error) {
      console.error('Error cleaning up old race data:', error);
    }
  }

  // runWithAutoRestart 関数内で使用するスケジュール設定を追加
  public setupCleanupSchedule() {
    schedule.scheduleJob('0 17 * * 0', async () => {
      console.log('Starting weekly cleanup of old race data');
      await this.cleanupOldRaceData();
    });
  }

  // ログ機能を強化
  private logWithTimestamp(level: 'info' | 'warn' | 'error', message: string, ...args: any[]): void {
    // UTCの時間を取得
    const utcTime = new Date();
    // 日本時間に変換（+9時間）
    const jstTime = new Date(utcTime.getTime() + 9 * 60 * 60 * 1000);
    
    // 日本時間のフォーマット（YYYY-MM-DDThh:mm:ss.sss+09:00）
    const jstTimestamp = jstTime.toISOString().replace('Z', '+09:00');
    const prefix = `[${jstTimestamp}] [${level.toUpperCase()}] [JST]`;
    
    if (level === 'info') {
      console.log(`${prefix} ${message}`, ...args);
    } else if (level === 'warn') {
      console.warn(`${prefix} ${message}`, ...args);
    } else if (level === 'error') {
      console.error(`${prefix} ${message}`, ...args);
    }
  }

  // 定期的なステータスレポートを生成
  public async generateStatusReport(): Promise<string> {
    try {
      // アクティブなジョブ数
      const activeJobsCount = this.activeJobs.size;
      
      // upcomingレース数
      const upcomingRaces = await this.withDbRetry(() => 
        db.query.races.findMany({
          where: eq(races.status, 'upcoming')
        })
      );
      
      // ブラウザの状態
      const browserStatus = this.browser ? 'active' : 'inactive';
      const browserUptime = this.browser ? 
        `${(new Date().getTime() - this.lastBrowserReset.getTime()) / (60 * 60 * 1000)} hours` : 
        'N/A';
      
      // レポート生成
      const report = [
        `Status Report at ${new Date().toISOString()}`,
        `Browser Status: ${browserStatus}`,
        `Browser Uptime: ${browserUptime}`,
        `Active Jobs: ${activeJobsCount}`,
        `Upcoming Races: ${upcomingRaces.length}`,
        `Upcoming Race IDs: ${upcomingRaces.map(r => r.id).join(', ')}`
      ].join('\n');
      
      this.logWithTimestamp('info', 'Status Report Generated');
      return report;
    } catch (error) {
      this.logWithTimestamp('error', 'Failed to generate status report:', error);
      return `Failed to generate status report: ${error}`;
    }
  }

  // 定期的なステータスレポートのスケジュール設定
  public setupStatusReportSchedule(): void {
    // 1時間ごとにステータスレポートを生成
    schedule.scheduleJob('0 * * * *', async () => {
      this.logWithTimestamp('info', 'Generating hourly status report...');
      const report = await this.generateStatusReport();
      this.logWithTimestamp('info', report);
    });
  }

  // 日本時間（JST）のフォーマット用ヘルパーメソッド
  private formatJSTTime(date: Date): string {
    // UTCの時間を取得し、日本時間に変換（+9時間）
    const JST_OFFSET = 9 * 60 * 60 * 1000;
    console.log('Debug - formatJSTTime - input date:', date.toISOString());
    const jstTime = new Date(date.getTime() + JST_OFFSET);
    console.log('Debug - formatJSTTime - jstTime:', jstTime.toISOString());
    
    // 日本時間のフォーマット（YYYY-MM-DDThh:mm:ss.sss+09:00）
    const result = jstTime.toISOString().replace('Z', '+09:00');
    console.log('Debug - formatJSTTime - result:', result);
    return result;
  }
}

// メイン実行関数
async function main() {
  const dailyCollector = new DailyOddsCollector();
  
  try {
    console.log('Starting odds collector with NODE_ENV:', process.env.NODE_ENV);
    await dailyCollector.initialize();
    
    // 定期的にupcomingレースをチェック（5分ごと）
    console.log('Setting up 5-min check schedule');
    schedule.scheduleJob('*/5 * * * *', async () => {
      console.log('Running upcoming races check...');
      await dailyCollector.checkUpcomingRaces();
    });

    // 初回実行
    console.log('Running initial race collection...');
    const races = await dailyCollector.getTodayGradeRaces();
    console.log('Found races:', races);
    
    for (const race of races) {
      console.log('Processing race:', race);
      await dailyCollector.registerRace(race);
      await dailyCollector.scheduleOddsCollection(race);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // 毎日8:55に再取得
    console.log('Setting up 8:55 schedule');
    schedule.scheduleJob('55 8 * * *', async () => {
      console.log('Running 8:55 race collection...');
      const races = await dailyCollector.getTodayGradeRaces();
      for (const race of races) {
        await dailyCollector.registerRace(race);
        await dailyCollector.scheduleOddsCollection(race);
      }
    });

  } catch (error) {
    console.error('Error in main process:', error);
  }
}

async function runWithAutoRestart() {
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;
  const INITIAL_RESTART_DELAY = 30000; // 30秒
  
  while (true) {
    try {
      console.log('Starting odds collector process...');
      const collector = new DailyOddsCollector();
      
      try {
        await collector.initialize();
        // 初期化に成功したらカウンターをリセット
        consecutiveFailures = 0;
      } catch (initError) {
        console.error('Failed to initialize collector:', initError);
        throw initError; // 再試行のために外側のcatchに投げる
      }
      
      // クリーンアップスケジュールを設定
      collector.setupCleanupSchedule();
      
      // ステータスレポートスケジュールを設定
      collector.setupStatusReportSchedule();
      
      // 初回のステータスレポートを生成
      console.log('Generating initial status report...');
      const initialReport = await collector.generateStatusReport();
      console.log(initialReport);
      
      // プロセス終了時のクリーンアップを設定
      process.on('SIGTERM', async () => {
        console.log('Received SIGTERM. Cleaning up...');
        await collector.cleanup();
        process.exit(0);
      });

      process.on('SIGINT', async () => {
        console.log('Received SIGINT. Cleaning up...');
        await collector.cleanup();
        process.exit(0);
      });

      // 予期せぬエラーのハンドリング
      process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception:', error);
        try {
          await collector.cleanup();
        } catch (cleanupError) {
          console.error('Error during cleanup after uncaught exception:', cleanupError);
        }
        process.exit(1);
      });

      // レース開催日（土日祝）のチェック関数
      const isRaceDay = () => {
        const now = new Date();
        const day = now.getDay();
        // 金曜日(5)、土曜日(6)、日曜日(0)、月曜日(1)
        return day === 5 || day === 6 || day === 0 || day === 1;
      };

      // レース開催日の場合のみ実行する処理
      const runRaceDayOperations = async () => {
        if (!isRaceDay()) {
          console.log('Not a race day. Skipping operations.');
          return;
        }

        console.log('Race day detected. Starting operations...');
        try {
          const races = await collector.getTodayGradeRaces();
          
          if (races.length === 0) {
            console.log('No races found for today.');
            return;
          }

          console.log(`Found ${races.length} races for today:`, races);
          for (const race of races) {
            await collector.registerRace(race);
            await collector.scheduleOddsCollection(race);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        } catch (error) {
          console.error('Error in runRaceDayOperations:', error);
          // エラー発生時にブラウザをリセットして回復を試みる
          await collector.recoverFromError('runRaceDayOperations');
        }
      };

      // 毎日8:55にレース情報取得（レース開催日のみ実行）
      console.log('Setting up 8:55 schedule');
      const morningJob = schedule.scheduleJob('55 8 * * *', runRaceDayOperations);

      // レース開催日の場合のみ5分間隔でチェック
      console.log('Setting up 5-min check schedule');
      const checkJob = schedule.scheduleJob('*/5 * * * *', async () => {
        if (!isRaceDay()) return;
        
        const now = new Date();
        const hour = now.getHours();
        
        // 9:00から17:00の間のみ実行
        if (hour >= 9 && hour < 17) {
          console.log('Running upcoming races check...');
          try {
            await collector.checkUpcomingRaces();
          } catch (error) {
            console.error('Error in scheduled checkUpcomingRaces:', error);
            await collector.recoverFromError('scheduled checkUpcomingRaces');
          }
        }
      });

      // ブラウザを6時間ごとにリセットするスケジュール
      console.log('Setting up browser reset schedule');
      const resetJob = schedule.scheduleJob('0 */6 * * *', async () => {
        console.log('Scheduled browser reset...');
        try {
          await collector.resetBrowser();
        } catch (error) {
          console.error('Error in scheduled browser reset:', error);
          await collector.recoverFromError('scheduled browser reset');
        }
      });

      // 毎日深夜にヘルスチェックを実行
      console.log('Setting up daily health check');
      const healthCheckJob = schedule.scheduleJob('0 3 * * *', async () => {
        console.log('Running daily health check...');
        try {
          const healthStatus = await collector.healthCheck();
          if (!healthStatus) {
            console.error('Daily health check failed');
            await collector.recoverFromError('daily health check');
          } else {
            console.log('Daily health check passed');
          }
        } catch (error) {
          console.error('Error in daily health check:', error);
          await collector.recoverFromError('daily health check');
        }
      });

      // ジョブ管理の定期チェックを設定（1時間ごと）
      console.log('Setting up job management check');
      const jobCheckJob = schedule.scheduleJob('0 * * * *', async () => {
        console.log('Running job management check...');
        try {
          // アクティブなジョブの状態を確認と復元
          await collector.checkAndRestoreRaceJobs();
        } catch (error) {
          console.error('Error in job management check:', error);
          await collector.recoverFromError('job management check');
        }
      });

      // 初回実行
      await runRaceDayOperations();

      // 無限ループを防ぐために待機
      await new Promise(() => {});

    } catch (error) {
      consecutiveFailures++;
      
      // 連続失敗回数に基づいて再起動の遅延を指数関数的に増加させる
      const restartDelay = Math.min(
        INITIAL_RESTART_DELAY * Math.pow(2, consecutiveFailures - 1),
        30 * 60 * 1000 // 最大30分
      );
      
      console.error(`Fatal error occurred (failure #${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, error);
      console.log(`Restarting process in ${restartDelay / 1000} seconds...`);
      
      // 連続失敗が多すぎる場合はプロセスを終了
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`Too many consecutive failures (${consecutiveFailures}). Exiting process.`);
        process.exit(1);
      }
      
      await new Promise(resolve => setTimeout(resolve, restartDelay));
    }
  }
}

// ESモジュール用のエントリーポイントチェック
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  runWithAutoRestart().catch(console.error);
} 