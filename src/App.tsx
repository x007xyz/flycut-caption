import { useState } from 'react'
import { ProjectsApp } from './components/Project/ProjectsApp'
import { zhCN, enUS, type FlyCutCaptionLocale } from './contexts/LocaleProvider'

// 创建自定义语言包示例 - 日语
const customJaJP: FlyCutCaptionLocale = {
  common: {
    loading: '読み込み中...',
    error: 'エラー',
    success: '成功',
    confirm: '確認',
    cancel: 'キャンセル',
    ok: 'OK',
    close: '閉じる',
    save: '保存',
    delete: '削除',
    edit: '編集',
    preview: 'プレビュー',
    export: 'エクスポート',
    import: 'インポート',
    reset: 'リセット',
    apply: '適用',
    search: '検索',
    clear: 'クリア',
    select: '選択',
    upload: 'アップロード',
    download: 'ダウンロード',
    retry: '再試行',
    back: '戻る',
    next: '次へ',
    previous: '前へ',
    finish: '完了',
    skip: 'スキップ',
    enable: '有効',
    disable: '無効',
    play: '再生',
    pause: '一時停止',
    stop: '停止',
    mute: 'ミュート',
    unmute: 'ミュート解除',
    fullscreen: 'フルスクリーン',
    exitFullscreen: 'フルスクリーン解除',
  },
  components: {
    fileUpload: {
      dragDropText: 'ビデオファイルをここにドラッグするか、クリックして選択',
      clickToSelect: 'クリックしてファイルを選択',
      supportedFormats: 'サポート形式：',
      maxFileSize: '最大ファイルサイズ：',
      selectFile: 'ファイルを選択',
      invalidFileType: 'サポートされていないファイル形式',
      fileTooLarge: 'ファイルが大きすぎます',
      uploadFailed: 'アップロードに失敗しました',
      uploadSuccess: 'アップロードが成功しました',
      processing: '処理中...',
      noFileSelected: 'ファイルが選択されていません',
      fileInfo: 'ファイル情報',
      fileName: 'ファイル名',
      fileSize: 'ファイルサイズ',
      fileType: 'ファイル形式',
      duration: '再生時間',
    },
    videoPlayer: {
      play: '再生',
      pause: '一時停止',
      stop: '停止',
      mute: 'ミュート',
      unmute: 'ミュート解除',
      fullscreen: 'フルスクリーン',
      exitFullscreen: 'フルスクリーン解除',
      volume: '音量',
      currentTime: '現在時間',
      duration: '再生時間',
      playbackRate: '再生速度',
      quality: '画質',
      subtitle: '字幕',
      showSubtitle: '字幕を表示',
      hideSubtitle: '字幕を非表示',
      previousFrame: '前のフレーム',
      nextFrame: '次のフレーム',
      skipBackward: '巻き戻し',
      skipForward: '早送り',
      subtitleLoading: '字幕フォントを読み込み中…',
      subtitleUnavailable: '字幕を描画できません',
      dragSubtitle: 'ドラッグして字幕の位置を調整',
    },
    subtitleEditor: {
      title: '字幕エディター',
      addSubtitle: '字幕を追加',
      editSubtitle: '字幕を編集',
      deleteSubtitle: '字幕を削除',
      deleteSelected: '選択項目を削除',
      selectAll: 'すべて選択',
      deselectAll: '選択を解除',
      mergeSubtitles: '字幕をマージ',
      adjustTiming: 'タイミング調整',
      startTime: '開始時間',
      endTime: '終了時間',
      text: 'テキスト',
      duration: '再生時間',
      timeline: 'タイムライン',
      waveform: '波形',
      zoomIn: 'ズームイン',
      zoomOut: 'ズームアウト',
      fitToScreen: '画面に合わせる',
      showWaveform: '波形を表示',
      hideWaveform: '波形を非表示',
      playSelection: '選択部分を再生',
      clearSelection: '選択をクリア',
      undoDelete: '削除を元に戻す',
      redoDelete: '削除をやり直す',
      searchSubtitle: '字幕を検索',
      replaceText: 'テキストを置換',
      translateSubtitle: '字幕を翻訳',
      exportSRT: 'SRTエクスポート',
      exportVTT: 'VTTエクスポート',
      exportJSON: 'JSONエクスポート',
      importSRT: 'SRTインポート',
      importVTT: 'VTTインポート',
      importJSON: 'JSONインポート',
      previewSubtitle: '字幕をプレビュー',
      subtitleStyle: '字幕スタイル',
      fontSize: 'フォントサイズ',
      fontColor: 'フォント色',
      backgroundColor: '背景色',
      outline: 'アウトライン',
      shadow: '影',
      position: '位置',
      alignment: '配置',
    },
    asrPanel: {
      title: '音声認識',
      startASR: '認識開始',
      stopASR: '認識停止',
      pauseASR: '認識一時停止',
      resumeASR: '認識再開',
      progress: '進行状況',
      status: 'ステータス',
      modelLoading: 'モデル読み込み中',
      modelLoaded: 'モデル読み込み完了',
      processing: '処理中',
      completed: '完了',
      failed: '失敗',
      cancelled: 'キャンセル済み',
      language: '言語',
      autoDetect: '自動検出',
      whisperModel: 'Whisperモデル',
      generateWordTimestamps: '単語レベルタイムスタンプ生成',
      enableVAD: 'VAD有効化',
      vadThreshold: 'VAD閾値',
      maxSegmentLength: '最大セグメント長',
      temperature: '温度',
      beamSize: 'ビームサイズ',
      patience: '忍耐度',
      lengthPenalty: '長さペナルティ',
      repetitionPenalty: '反復ペナルティ',
      noRepeatNgramSize: '非反復Ngramサイズ',
      initialPrompt: '初期プロンプト',
      suppressBlank: '空白抑制',
      suppressTokens: 'トークン抑制',
      withoutTimestamps: 'タイムスタンプなし',
      maxInitialTimestamp: '最大初期タイムスタンプ',
      wordTimestamps: '単語タイムスタンプ',
      prependPunctuations: '前置句読点',
      appendPunctuations: '後置句読点',
      lastTokensToIgnore: '無視する最後のトークン',
      modelSettings: 'モデル設定',
      advancedSettings: '高度な設定',
      resetSettings: '設定をリセット',
      saveSettings: '設定を保存',
      loadSettings: '設定を読み込み',
    },
    exportDialog: {
      title: 'エクスポート設定',
      format: 'フォーマット',
      quality: '品質',
      resolution: '解像度',
      frameRate: 'フレームレート',
      bitrate: 'ビットレート',
      codec: 'コーデック',
      container: 'コンテナ',
      includeAudio: '音声を含む',
      audioCodec: '音声コーデック',
      audioBitrate: '音声ビットレート',
      audioSampleRate: '音声サンプルレート',
      includeSubtitle: '字幕を含む',
      burnSubtitle: '字幕を焼き込み',
      subtitleTrack: '字幕トラック',
      outputFile: '出力ファイル',
      exportVideo: 'ビデオエクスポート',
      exportAudio: '音声エクスポート',
      exportSubtitle: '字幕エクスポート',
      exportAll: 'すべてエクスポート',
      previewExport: 'エクスポートプレビュー',
      exportProgress: 'エクスポート進行状況',
      exportSuccess: 'エクスポート成功',
      exportFailed: 'エクスポート失敗',
      exportCancelled: 'エクスポートキャンセル',
      estimatedSize: '推定サイズ',
      estimatedTime: '推定時間',
    },
    messageCenter: {
      title: 'メッセージセンター',
      noMessages: 'メッセージなし',
      clearAll: 'すべてクリア',
      markAllRead: 'すべて既読にする',
      filter: 'フィルター',
      allMessages: 'すべてのメッセージ',
      errors: 'エラー',
      warnings: '警告',
      info: '情報',
      success: '成功',
      timestamp: 'タイムスタンプ',
      details: '詳細',
      dismiss: '無視',
      retry: '再試行',
      report: 'レポート',
    },
    themeToggle: {
      light: 'ライト',
      dark: 'ダーク',
      auto: '自動',
      toggleTheme: 'テーマ切り替え',
    },
    languageSelector: {
      language: '言語',
      selectLanguage: '言語を選択',
      chinese: '中文',
      english: 'English',
      japanese: '日本語',
      korean: '한국어',
      french: 'Français',
      german: 'Deutsch',
      spanish: 'Español',
      portuguese: 'Português',
      russian: 'Русский',
      arabic: 'العربية',
      hindi: 'हिन्दी',
    },
    aiSettings: {
      title: 'AIモデル管理',
      description: 'OpenAI互換のAIモデルを追加して、字幕の校正と翻訳に使用します。',
      addModel: 'モデルを追加',
      editModel: 'モデルを編集',
      name: '名称',
      baseUrl: 'Base URL',
      apiKey: 'API Key',
      model: 'モデル',
      temperature: '温度',
      selectModel: 'モデルを選択',
      noModel: 'モデルがありません',
      delete: '削除',
      save: '保存',
      cancel: 'キャンセル',
      apiKeyHint: 'API Keyはブラウザのローカルに平文で保存されます。共有デバイスでは機密キーを保存しないでください。',
      useThisModel: 'このモデルを使う',
      emptyTip: 'AIモデルが未追加です。「モデルを追加」から設定してください。',
    },
  },
  messages: {
    fileUpload: {
      selectFile: 'ファイルを選択してください',
      uploadInProgress: 'ファイルアップロード中...',
      uploadSuccess: 'ファイルアップロード成功',
      uploadFailed: 'ファイルアップロード失敗',
      urlLoadFailed: 'URLの読み込みに失敗しました。リンクを確認してください。',
      invalidFileType: 'サポートされていないファイル形式',
      fileTooLarge: 'ファイルサイズが制限を超えています',
      networkError: 'ネットワークエラー、接続を確認してください',
      serverError: 'サーバーエラー、後でもう一度お試しください',
      processingFile: 'ファイル処理中...',
      extractingAudio: '音声抽出中...',
      analyzingAudio: '音声解析中...',
      generatingSubtitles: '字幕生成中...',
      processingComplete: 'ファイル処理完了',
      processingFailed: 'ファイル処理失敗',
      processingCancelled: 'ファイル処理キャンセル',
    },
    asr: {
      modelDownloading: '音声認識モデルダウンロード中...',
      modelDownloaded: '音声認識モデルダウンロード完了',
      modelDownloadFailed: '音声認識モデルダウンロード失敗',
      initializingModel: '音声認識モデル初期化中...',
      modelInitialized: '音声認識モデル初期化完了',
      modelInitializationFailed: '音声認識モデル初期化失敗',
      asrStarted: '音声認識開始',
      asrProgress: '音声認識進行状況',
      asrCompleted: '音声認識完了',
      asrFailed: '音声認識失敗',
      asrCancelled: '音声認識キャンセル',
      noAudioDetected: '音声信号が検出されません',
      audioTooShort: '音声が短すぎます',
      audioTooLong: '音声が長すぎます',
      unsupportedAudioFormat: 'サポートされていない音声形式',
      insufficientMemory: 'メモリ不足',
      networkTimeout: 'ネットワークタイムアウト',
      loadSampleFailed: 'サンプル動画の読み込みに失敗しました',
    },
    export: {
      exportStarted: 'エクスポート開始',
      exportProgress: 'エクスポート進行状況',
      exportCompleted: 'エクスポート完了',
      exportFailed: 'エクスポート失敗',
      exportCancelled: 'エクスポートキャンセル',
      invalidParameters: '無効なエクスポートパラメータ',
      insufficientSpace: 'ディスク容量不足',
      encodingError: 'エンコードエラー',
      ioError: '入出力エラー',
      permissionDenied: 'アクセス拒否',
    },
    subtitle: {
      subtitleAdded: '字幕を追加しました',
      subtitleEdited: '字幕を編集しました',
      subtitleDeleted: '字幕を削除しました',
      subtitlesMerged: '字幕をマージしました',
      subtitleSplit: '字幕を分割しました',
      timingAdjusted: 'タイミングを調整しました',
      textReplaced: 'テキストを置換しました',
      subtitleTranslated: '字幕を翻訳しました',
      invalidTimeRange: '無効な時間範囲',
      overlappingSubtitles: '字幕の時間が重複しています',
      emptySubtitleText: '字幕テキストが空です',
      exportFailed: '字幕のエクスポートに失敗しました',
      originalConfirmFailed: '原言語字幕の適用に失敗しました',
      maxSubtitlesReached: '最大字幕数に達しました',
      undoLimit: '元に戻す制限に達しました',
      redoLimit: 'やり直し制限に達しました',
    },
    video: {
      videoLoaded: 'ビデオ読み込み完了',
      videoLoadFailed: 'ビデオ読み込み失敗',
      seekCompleted: 'シーク完了',
      playbackError: '再生エラー',
      networkError: 'ネットワークエラー',
      decodingError: 'デコードエラー',
      unsupportedFormat: 'サポートされていない形式',
      videoTooLarge: 'ビデオファイルが大きすぎます',
      videoTooLong: 'ビデオが長すぎます',
      audioTrackMissing: '音声トラックがありません',
      videoTrackMissing: 'ビデオトラックがありません',
    },
    general: {
      operationSuccess: '操作成功',
      operationFailed: '操作失敗',
      operationCancelled: '操作キャンセル',
      saveSuccess: '保存成功',
      saveFailed: '保存失敗',
      loadSuccess: '読み込み成功',
      loadFailed: '読み込み失敗',
      deleteSuccess: '削除成功',
      deleteFailed: '削除失敗',
      copySuccess: 'コピー成功',
      copyFailed: 'コピー失敗',
      pasteSuccess: '貼り付け成功',
      pasteFailed: '貼り付け失敗',
      connectionLost: '接続が切断されました',
      connectionRestored: '接続が復旧しました',
      sessionExpired: 'セッションが期限切れです',
      accessDenied: 'アクセス拒否',
      rateLimitExceeded: 'レート制限を超えました',
      serviceUnavailable: 'サービス利用不可',
      maintenanceMode: 'メンテナンスモード',
      updateAvailable: 'アップデートが利用可能',
      updateRequired: 'アップデートが必要',
      compatibilityIssue: '互換性の問題',
      browserNotSupported: 'ブラウザがサポートされていません',
      featureNotSupported: '機能がサポートされていません',
      experimentalFeature: '実験的機能',
    },
  },
}

/**
 * App Component - Demo App using FlyCutCaption
 *
 * This is the main demo application that demonstrates componentized internationalization.
 * It shows how to integrate custom locale packages and provide language switching UI.
 */
function App() {
  const initialLanguage = new URLSearchParams(window.location.search).get('ui') === 'en' ? 'en' : 'zh'
  const [currentLanguage, setCurrentLanguage] = useState(initialLanguage)
  const [currentLocale, setCurrentLocale] = useState<FlyCutCaptionLocale | undefined>(undefined)

  const handleLanguageChange = (language: string) => {
    console.log('Language changed to:', language)
    setCurrentLanguage(language)

    // 根据语言设置相应的语言包
    switch (language) {
      case 'zh':
      case 'zh-CN':
        setCurrentLocale(zhCN)
        break
      case 'en':
      case 'en-US':
        setCurrentLocale(enUS)
        break
      case 'ja':
      case 'ja-JP':
        setCurrentLocale(customJaJP)
        break
      default:
        setCurrentLocale(undefined) // 使用默认语言包
    }
  }

  return (
    <ProjectsApp
      config={{
        theme: 'auto',
        language: currentLanguage
      }}
      locale={currentLocale}
      onLanguageChange={handleLanguageChange}
      onError={(error) => {
        console.error('Component error:', error)
      }}
      onProgress={(stage, progress) => {
        console.log(`Progress: ${stage} - ${progress}%`)
      }}
      onReady={() => {
        console.log('FlyCut Caption is ready')
      }}
      onFileSelected={(file) => {
        console.log('File selected:', file.name)
      }}
      onSubtitleGenerated={(subtitles) => {
        console.log('Subtitles generated:', subtitles.length)
      }}
      onSubtitleChanged={(subtitles) => {
        console.log('Subtitles changed:', subtitles.length)
      }}
      onVideoProcessed={(blob, filename) => {
        console.log('Video processed:', filename, blob.size, 'bytes')
      }}
      onExportComplete={(blob, filename) => {
        console.log('Export complete:', filename, blob.size, 'bytes')
      }}
    />
  )
}

export default App
