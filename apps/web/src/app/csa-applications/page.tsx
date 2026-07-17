'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import { api } from '@/lib/api'
import type {
  CsaContactControl,
  CsaContactStatus,
  CsaFunnelApplicant,
  CsaFunnelApplicantList,
  CsaFunnelStage,
  CsaFunnelSummary,
} from '@/lib/api'

type TabId = 'progress' | 'applicants' | 'attention' | 'reminders' | 'audit'
type PeriodId = 'campaign' | 'all'

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'progress', label: '進捗ボード' },
  { id: 'applicants', label: '申込者一覧' },
  { id: 'attention', label: '要対応' },
  { id: 'reminders', label: '配信・リマインド' },
  { id: 'audit', label: '監査ログ・設定' },
]

const stageLabels: Record<CsaFunnelStage, string> = {
  keyword_received: '「決済」送信',
  form_issued: 'フォーム発行済み',
  form_opened: 'フォーム閲覧済み',
  form_submitted: 'フォーム送信済み',
  payment_pending: '支払い待ち',
  payment_reported: '支払申告済み',
  payment_verified: '決済確認済み',
  onboarding_sent: '会員登録案内済み',
  membership_active: '会員化完了',
  discord_linked: 'Discord連携完了',
}

const reminderRules = [
  ['「決済」キーワード送信後、フォーム未閲覧', '翌日 12:00', '初回1回'],
  ['フォーム閲覧後、未送信', '翌日 12:00', '初回1回'],
  ['初回確認後もフォーム未送信', '翌々日 18:00', '最終1回'],
  ['カード選択後、決済未確認', '翌日 18:00', '手動確認'],
  ['銀行振込選択後、完了申告なし', '翌日 18:00', '手動確認'],
  ['支払申告済み・決済未確認', 'すぐに運営確認', '本人には送らない'],
  ['会員登録案内後、未完了', '3日後 18:00', '1回'],
]

const reminderTemplates = [
  ['フォーム未閲覧', '先ほどお送りしたCSAのお申し込みフォームは、ご都合のよい時にご確認ください。開けない場合やご不明点があれば、このLINEへそのままご返信ください。'],
  ['フォーム未送信', 'CSAのお申し込みフォームについて、途中で分かりにくい点はありませんでしたか？ ご不明点があれば、このLINEへそのままご相談ください。'],
  ['カード決済待ち', 'カード決済について、ご不明点やお手続き上の問題があれば、このLINEへご返信ください。支払時期のご相談も承ります。'],
  ['銀行振込待ち', '銀行振込について、ご不明点や振込予定日のご相談があれば、このLINEへご返信ください。すでにお手続き済みの場合は行き違いをご容赦ください。'],
  ['会員登録未完了', '会員登録のご案内後、操作でお困りの点はありませんか？ ログインやDiscord連携など、ご不明点があればこのLINEへご返信ください。'],
]

const contactStatusLabels: Record<CsaContactStatus, string> = {
  normal: '通常',
  payment_discussion: '支払い相談中',
  payment_date_set: '支払予定日あり',
  considering: '検討中',
  manual_handling: '手動対応中',
  do_not_contact: '連絡しない',
}

const candidateStateLabels: Record<CsaFunnelApplicant['reminderCandidate']['state'], string> = {
  due: '確認期限',
  upcoming: '予定',
  paused: '停止中',
  disabled: '対象外',
  internal_only: '運営確認',
  complete: '完了',
  none: '候補なし',
}

const attentionLabels: Record<string, string> = {
  paymentMethodMismatch: '支払方法が一致していません',
  formNotSubmitted: 'フォームが未送信です',
  paymentVerificationPending: '決済確認を待っています',
  paymentNotReported: '支払完了の申告がありません',
  activationNotSent: '会員登録案内が未送信です',
  activationIncomplete: '会員登録が完了していません',
  discordNotLinked: 'Discordが未連携です',
}

const emptySummary: CsaFunnelSummary = {
  stages: [],
  attentionCount: 0,
  mismatchCount: 0,
  autoReminderEnabled: false,
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRate(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const percent = value <= 1 ? value * 100 : value
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`
}

function stageLabel(stage: CsaFunnelStage) {
  return stageLabels[stage] || stage
}

function paymentLabel(method: CsaFunnelApplicant['paymentMethod']) {
  if (method === 'card') return 'カード'
  if (method === 'bank_transfer') return '銀行振込'
  return '未選択'
}

function attentionLabel(reason?: string | null) {
  if (!reason) return null
  return attentionLabels[reason] || reason
}

function StatusBadge({ applicant }: { applicant: CsaFunnelApplicant }) {
  const hasMismatch = Boolean(applicant.paymentMismatch || applicant.mismatchWarnings?.length)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
        {stageLabel(applicant.currentStage)}
      </span>
      {hasMismatch && (
        <span className="inline-flex rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
          不一致
        </span>
      )}
    </div>
  )
}

function ApplicantIdentity({ applicant }: { applicant: CsaFunnelApplicant }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {applicant.pictureUrl ? (
        <img src={applicant.pictureUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold text-gray-600">
          {(applicant.displayName || '?').slice(0, 1)}
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-gray-900">{applicant.displayName || '表示名なし'}</p>
        <p className="truncate text-xs text-gray-400">ID: {applicant.friendId || applicant.lineUserId}</p>
      </div>
    </div>
  )
}

function ApplicantTable({ applicants, onEdit }: { applicants: CsaFunnelApplicant[]; onEdit: (applicant: CsaFunnelApplicant) => void }) {
  if (applicants.length === 0) {
    return <EmptyState text="条件に該当する申込者はいません" />
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
        <table className="w-full min-w-[1080px]">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              {['申込者', '現在の段階', '支払方法', '決済キーワード', 'フォーム送信', '支払申告', '決済確認', '候補・個別設定', '操作'].map((label) => (
                <th key={label} className="px-4 py-3 text-left text-xs font-semibold text-gray-500">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {applicants.map((applicant) => (
              <tr key={applicant.friendId || applicant.lineUserId} className="align-top hover:bg-gray-50/70">
                <td className="px-4 py-4"><ApplicantIdentity applicant={applicant} /></td>
                <td className="px-4 py-4"><StatusBadge applicant={applicant} /></td>
                <td className="px-4 py-4 text-sm text-gray-700">{paymentLabel(applicant.paymentMethod)}</td>
                <td className="px-4 py-4 text-xs text-gray-500 whitespace-nowrap">{formatDate(applicant.keywordReceivedAt)}</td>
                <td className="px-4 py-4 text-xs text-gray-500 whitespace-nowrap">{formatDate(applicant.formSubmittedAt)}</td>
                <td className="px-4 py-4 text-xs text-gray-500 whitespace-nowrap">{formatDate(applicant.paymentReportedAt)}</td>
                <td className="px-4 py-4 text-xs text-gray-500 whitespace-nowrap">{formatDate(applicant.paymentVerifiedAt)}</td>
                <td className="max-w-[230px] px-4 py-4 text-sm">
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${applicant.reminderCandidate.state === 'due' ? 'bg-red-50 text-red-700' : applicant.reminderCandidate.state === 'internal_only' ? 'bg-amber-50 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                    {candidateStateLabels[applicant.reminderCandidate.state]}
                  </span>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{applicant.reminderCandidate.reason}</p>
                  {applicant.reminderCandidate.dueAt && <p className="mt-1 text-xs font-medium text-gray-700">{formatDate(applicant.reminderCandidate.dueAt)}</p>}
                  {applicant.reminderCount > 0 && (
                    <p className="mt-1 text-xs text-gray-400">リマインド {applicant.reminderCount}回</p>
                  )}
                </td>
                <td className="px-4 py-4"><button onClick={() => onEdit(applicant)} className="min-h-10 whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50">対応設定</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {applicants.map((applicant) => (
          <article key={applicant.friendId || applicant.lineUserId} className="rounded-xl border border-gray-200 bg-white p-4">
            <ApplicantIdentity applicant={applicant} />
            <div className="mt-4"><StatusBadge applicant={applicant} /></div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt className="text-xs text-gray-400">支払方法</dt><dd className="mt-1 text-gray-700">{paymentLabel(applicant.paymentMethod)}</dd></div>
              <div><dt className="text-xs text-gray-400">最終接触</dt><dd className="mt-1 text-gray-700">{formatDate(applicant.lastContactAt)}</dd></div>
              <div><dt className="text-xs text-gray-400">フォーム送信</dt><dd className="mt-1 text-gray-700">{formatDate(applicant.formSubmittedAt)}</dd></div>
              <div><dt className="text-xs text-gray-400">決済確認</dt><dd className="mt-1 text-gray-700">{formatDate(applicant.paymentVerifiedAt)}</dd></div>
            </dl>
            {applicant.attentionReason && (
              <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                {attentionLabel(applicant.attentionReason)}
              </div>
            )}
            <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600">
              <span className="font-semibold">{candidateStateLabels[applicant.reminderCandidate.state]}</span>：{applicant.reminderCandidate.reason}
              {applicant.reminderCandidate.dueAt && <span className="block font-medium">{formatDate(applicant.reminderCandidate.dueAt)}</span>}
            </div>
            <button onClick={() => onEdit(applicant)} className="mt-3 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700">対応設定</button>
          </article>
        ))}
      </div>
    </>
  )
}

function toLocalInput(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function ContactControlDialog({ applicant, saving, error, onClose, onSave }: {
  applicant: CsaFunnelApplicant
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (value: Pick<CsaContactControl, 'remindersEnabled' | 'contactStatus' | 'pauseUntil' | 'promisedPaymentAt' | 'resumeMode' | 'operatorNote'>) => void
}) {
  const [remindersEnabled, setRemindersEnabled] = useState(applicant.contactControl.remindersEnabled)
  const [contactStatus, setContactStatus] = useState(applicant.contactControl.contactStatus)
  const [pauseUntil, setPauseUntil] = useState(toLocalInput(applicant.contactControl.pauseUntil))
  const [promisedPaymentAt, setPromisedPaymentAt] = useState(toLocalInput(applicant.contactControl.promisedPaymentAt))
  const [resumeMode, setResumeMode] = useState(applicant.contactControl.resumeMode)
  const [operatorNote, setOperatorNote] = useState(applicant.contactControl.operatorNote || '')

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-gray-950/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="個別対応設定">
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-2xl sm:rounded-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-lg font-bold text-gray-900">個別対応設定</h2><p className="mt-1 text-sm text-gray-500">{applicant.displayName || '表示名なし'}／{stageLabel(applicant.currentStage)}</p></div>
          <button onClick={onClose} disabled={saving} className="min-h-11 rounded-lg px-3 text-sm font-medium text-gray-500">閉じる</button>
        </div>
        <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
          現在の候補：<span className="font-bold">{candidateStateLabels[applicant.reminderCandidate.state]}</span><br />{applicant.reminderCandidate.reason}
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <label className="flex min-h-12 items-center justify-between rounded-xl border border-gray-200 px-4 text-sm font-semibold text-gray-800 sm:col-span-2">
            この人をリマインド候補に含める
            <input type="checkbox" checked={remindersEnabled} onChange={(event) => setRemindersEnabled(event.target.checked)} className="h-5 w-5 accent-green-600" />
          </label>
          <label className="text-sm font-semibold text-gray-700">対応状態
            <select value={contactStatus} onChange={(event) => setContactStatus(event.target.value as CsaContactStatus)} className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal">
              {Object.entries(contactStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold text-gray-700">再開方法
            <select value={resumeMode} onChange={(event) => setResumeMode(event.target.value as CsaContactControl['resumeMode'])} className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal">
              <option value="candidate">期限後に候補へ戻す</option><option value="manual">手動で再開</option><option value="never">再開しない</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-gray-700">一時停止期限
            <input type="datetime-local" value={pauseUntil} onChange={(event) => setPauseUntil(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal" />
          </label>
          <label className="text-sm font-semibold text-gray-700">支払予定日時
            <input type="datetime-local" value={promisedPaymentAt} onChange={(event) => setPromisedPaymentAt(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-normal" />
          </label>
          <label className="text-sm font-semibold text-gray-700 sm:col-span-2">運営メモ
            <textarea value={operatorNote} onChange={(event) => setOperatorNote(event.target.value)} maxLength={1000} rows={4} placeholder="例：給料日の7/25に支払予定。本人から連絡あり。" className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal leading-6" />
          </label>
        </div>
        {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button onClick={onClose} disabled={saving} className="min-h-11 rounded-lg border border-gray-300 px-5 text-sm font-semibold text-gray-700">キャンセル</button>
          <button onClick={() => onSave({ remindersEnabled, contactStatus, pauseUntil: pauseUntil ? new Date(pauseUntil).toISOString() : null, promisedPaymentAt: promisedPaymentAt ? new Date(promisedPaymentAt).toISOString() : null, resumeMode, operatorNote: operatorNote.trim() || null })} disabled={saving} className="min-h-11 rounded-lg bg-green-700 px-5 text-sm font-bold text-white disabled:opacity-50">{saving ? '保存中...' : '設定を保存'}</button>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">{text}</div>
}

export default function CsaApplicationsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('progress')
  const [summary, setSummary] = useState<CsaFunnelSummary>(emptySummary)
  const [applicantList, setApplicantList] = useState<CsaFunnelApplicantList>({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stageFilter, setStageFilter] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('')
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState<PeriodId>('campaign')
  const [editingApplicant, setEditingApplicant] = useState<CsaFunnelApplicant | null>(null)
  const [savingControl, setSavingControl] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const campaignKey = period === 'all' ? 'all' : 'current'
    const [summaryResult, applicantsResult] = await Promise.allSettled([
      api.csaFunnel.summary({ campaignKey }),
      api.csaFunnel.applicants({ campaignKey, limit: 200 }),
    ])

    if (summaryResult.status === 'fulfilled' && summaryResult.value.success) {
      setSummary({ ...emptySummary, ...summaryResult.value.data })
    }
    if (applicantsResult.status === 'fulfilled' && applicantsResult.value.success) {
      setApplicantList(applicantsResult.value.data)
    }
    const summaryFailed = summaryResult.status === 'rejected'
      || (summaryResult.status === 'fulfilled' && !summaryResult.value.success)
    const applicantsFailed = applicantsResult.status === 'rejected'
      || (applicantsResult.status === 'fulfilled' && !applicantsResult.value.success)
    if (summaryFailed || applicantsFailed) {
      setError('申込進捗を取得できませんでした。通信状態を確認して再読み込みしてください。')
    }
    setLoading(false)
  }, [period])

  useEffect(() => { void load() }, [load])

  const periodApplicants = applicantList.items

  const displayedSummary = useMemo<CsaFunnelSummary>(() => {
    return summary
  }, [summary])

  const filteredApplicants = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('ja-JP')
    return periodApplicants.filter((applicant) => {
      if (stageFilter && applicant.currentStage !== stageFilter) return false
      if (paymentFilter && applicant.paymentMethod !== paymentFilter) return false
      if (normalizedSearch && !(applicant.displayName || '').toLocaleLowerCase('ja-JP').includes(normalizedSearch)) return false
      return true
    })
  }, [paymentFilter, periodApplicants, search, stageFilter])

  const attentionApplicants = useMemo(
    () => periodApplicants.filter((applicant) => applicant.attentionReason || applicant.paymentMismatch || applicant.mismatchWarnings?.length),
    [periodApplicants],
  )
  const reminderCandidates = useMemo(
    () => periodApplicants.filter((applicant) => ['due', 'upcoming', 'internal_only', 'paused'].includes(applicant.reminderCandidate.state)),
    [periodApplicants],
  )

  const openStage = (stage: CsaFunnelStage) => {
    setStageFilter(stage)
    setActiveTab('applicants')
  }

  const saveContactControl = async (value: Pick<CsaContactControl, 'remindersEnabled' | 'contactStatus' | 'pauseUntil' | 'promisedPaymentAt' | 'resumeMode' | 'operatorNote'>) => {
    if (!editingApplicant) return
    setSavingControl(true)
    setControlError(null)
    try {
      const result = await api.csaFunnel.updateContactControl(editingApplicant.lineUserId, value)
      if (!result.success) throw new Error('save failed')
      setEditingApplicant(null)
      await load()
    } catch {
      setControlError('保存できませんでした。入力内容と通信状態を確認してください。')
    } finally {
      setSavingControl(false)
    }
  }

  if (loading) {
    return (
      <div>
        <Header title="CSA申込管理" description="LINEから決済確認・会員化までの進捗" />
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">申込進捗を読み込んでいます...</div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      <Header
        title="CSA申込管理"
        description="「決済」の送信からフォーム、決済確認、会員化までを一人ずつ追跡"
        action={
          <button onClick={() => void load()} className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">
            再読み込み
          </button>
        }
      />

      <div className={`mb-6 flex items-start gap-3 rounded-xl border px-4 py-3 ${summary.autoReminderEnabled ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${summary.autoReminderEnabled ? 'bg-red-500' : 'bg-gray-400'}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${summary.autoReminderEnabled ? 'text-red-800' : 'text-gray-800'}`}>
            自動配信：{summary.autoReminderEnabled ? 'ON（要確認）' : 'OFF'}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-gray-500">リマインド候補は確認できますが、この画面から自動送信は行いません。</p>
        </div>
      </div>

      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-900">表示期間</p>
          <p className="mt-1 text-xs text-gray-500">今回キャンペーン：2026年7月17日 20:00（JST）以降</p>
        </div>
        <div className="flex rounded-lg bg-gray-100 p-1" role="group" aria-label="表示期間">
          <button onClick={() => setPeriod('campaign')} className={`min-h-10 rounded-md px-3 text-sm font-medium ${period === 'campaign' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>今回キャンペーン</button>
          <button onClick={() => setPeriod('all')} className={`min-h-10 rounded-md px-3 text-sm font-medium ${period === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>全期間</button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-6 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-red-800">{error}</p>
          <button onClick={() => void load()} className="min-h-11 rounded-lg border border-red-300 bg-white px-4 text-sm font-semibold text-red-700">再試行</button>
        </div>
      )}

      <div className="mb-6 overflow-x-auto border-b border-gray-200">
        <div className="flex min-w-max gap-1" role="tablist" aria-label="CSA申込管理メニュー">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-11 border-b-2 px-4 text-sm font-medium transition-colors ${
                activeTab === tab.id ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {tab.label}
              {tab.id === 'attention' && displayedSummary.attentionCount > 0 && (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{displayedSummary.attentionCount}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'progress' && (
        <section aria-label="進捗ボード">
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {displayedSummary.stages.length === 0 ? (
              <div className="col-span-full"><EmptyState text="進捗データはまだありません" /></div>
            ) : displayedSummary.stages.map((stage) => (
              <button key={stage.key} onClick={() => openStage(stage.key)} className="rounded-xl border border-gray-200 bg-white p-4 text-left transition hover:border-green-300 hover:shadow-sm">
                <p className="min-h-10 text-sm font-medium leading-5 text-gray-600">{stageLabel(stage.key)}</p>
                <p className="mt-2 text-3xl font-bold text-gray-900">{stage.count}<span className="ml-1 text-sm font-medium text-gray-400">人</span></p>
                <p className="mt-3 text-xs font-medium text-green-700">該当者を見る →</p>
              </button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold text-gray-900">転換率</h2>
              <dl className="mt-4 divide-y divide-gray-100">
                {[
                  ['キーワード → フォーム送信', formatRate(displayedSummary.conversionRates?.keywordToFormSubmitted)],
                  ['フォーム送信 → 決済確認', formatRate(displayedSummary.conversionRates?.formSubmittedToPaymentVerified)],
                  ['決済確認 → 会員化', formatRate(displayedSummary.conversionRates?.paymentVerifiedToActivated)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between py-3"><dt className="text-sm text-gray-600">{label}</dt><dd className="text-lg font-bold text-gray-900">{value}</dd></div>
                ))}
              </dl>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold text-gray-900">運営確認</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button onClick={() => setActiveTab('attention')} className="rounded-lg bg-amber-50 p-4 text-left">
                  <p className="text-sm font-medium text-amber-800">要対応</p><p className="mt-1 text-3xl font-bold text-amber-900">{displayedSummary.attentionCount}</p>
                </button>
                <button onClick={() => setActiveTab('attention')} className="rounded-lg bg-red-50 p-4 text-left">
                  <p className="text-sm font-medium text-red-800">データ不一致</p><p className="mt-1 text-3xl font-bold text-red-900">{displayedSummary.mismatchCount}</p>
                </button>
              </div>
              <p className="mt-4 text-xs leading-5 text-gray-500">本人の支払申告と、運営による決済確認は別の状態として表示します。</p>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'applicants' && (
        <section aria-label="申込者一覧">
          <div className="mb-4 grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_220px_180px_auto]">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="LINE表示名で検索" className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-green-500" />
            <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-sm">
              <option value="">すべての段階</option>
              {displayedSummary.stages.map((stage) => <option key={stage.key} value={stage.key}>{stageLabel(stage.key)}</option>)}
            </select>
            <select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-sm">
              <option value="">すべての支払方法</option><option value="card">カード</option><option value="bank_transfer">銀行振込</option>
            </select>
            <button onClick={() => { setSearch(''); setStageFilter(''); setPaymentFilter('') }} className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-600 hover:bg-gray-50">絞り込み解除</button>
          </div>
          <p className="mb-3 text-sm text-gray-500">{filteredApplicants.length}人を表示（対象期間 {periodApplicants.length}人）</p>
          <ApplicantTable applicants={filteredApplicants} onEdit={(applicant) => { setControlError(null); setEditingApplicant(applicant) }} />
        </section>
      )}

      {activeTab === 'attention' && (
        <section aria-label="要対応">
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">今日、確認が必要な申込者</p>
            <p className="mt-1 text-xs leading-5 text-amber-800">赤い「不一致」は運営確認を優先し、黄色の理由は本人の次の操作を確認してください。</p>
          </div>
          <ApplicantTable applicants={attentionApplicants} onEdit={(applicant) => { setControlError(null); setEditingApplicant(applicant) }} />
        </section>
      )}

      {activeTab === 'reminders' && (
        <section aria-label="配信・リマインド">
          <div className="mb-5 rounded-xl border border-gray-300 bg-gray-50 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><h2 className="text-base font-semibold text-gray-900">自動配信はOFFです</h2><p className="mt-1 text-sm text-gray-600">3時間経過を送信条件にはしていません。候補は運営が日中に確認します。</p></div>
              <span className="w-fit rounded-full bg-gray-200 px-3 py-1.5 text-sm font-bold text-gray-700">OFF</span>
            </div>
          </div>
          <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900">
            将来送信機能を有効にする場合も、送信可能時間は日中に限定し、対象人数と本文の手動確認を必須にします。現在、送信操作は未実装です。
          </div>
          <div className="mb-5 rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between gap-4"><div><h3 className="text-base font-semibold text-gray-900">現在の確認候補</h3><p className="mt-1 text-sm text-gray-500">期限・停止理由を個別に確認できます。</p></div><span className="rounded-full bg-blue-50 px-3 py-1 text-sm font-bold text-blue-700">{reminderCandidates.length}人</span></div>
            <div className="mt-4 divide-y divide-gray-100">
              {reminderCandidates.length === 0 ? <p className="py-5 text-center text-sm text-gray-500">現在の候補はいません</p> : reminderCandidates.map((applicant) => (
                <div key={applicant.lineUserId} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-gray-900">{applicant.displayName || '表示名なし'}</p><p className="mt-1 text-xs leading-5 text-gray-500">{applicant.reminderCandidate.reason}</p></div>
                  <div className="flex items-center gap-2"><span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">{candidateStateLabels[applicant.reminderCandidate.state]}</span><button onClick={() => { setControlError(null); setEditingApplicant(applicant) }} className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700">対応設定</button></div>
                </div>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full min-w-[620px]">
              <thead className="border-b border-gray-200 bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">対象</th><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">運営確認の目安</th><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">判断</th><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th></tr></thead>
              <tbody className="divide-y divide-gray-100">{reminderRules.map(([target, timing, limit]) => <tr key={target}><td className="px-4 py-4 text-sm font-medium text-gray-800">{target}</td><td className="px-4 py-4 text-sm text-gray-600">{timing}</td><td className="px-4 py-4 text-sm text-gray-600">{limit}</td><td className="px-4 py-4"><span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">自動送信OFF</span></td></tr>)}</tbody>
            </table>
          </div>
          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">確認用文面（まだ送信されません）</h3>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {reminderTemplates.map(([label, copy]) => <div key={label} className="rounded-lg border border-gray-200 bg-gray-50 p-4"><p className="text-xs font-bold text-gray-700">{label}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-600">{copy}</p></div>)}
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">送信時の必須制御</h3>
            <ul className="mt-3 grid gap-2 text-sm text-gray-600 sm:grid-cols-2">
              <li>・次の段階へ進んだ人を即時除外</li><li>・同一内容の二重送信を禁止</li><li>・21時〜翌9時は送信しない</li><li>・ブロック・配信停止者を除外</li><li>・送信前に対象人数と本文を確認</li><li>・最大2回で自動停止</li>
            </ul>
          </div>
        </section>
      )}

      {activeTab === 'audit' && (
        <section aria-label="監査ログ・設定" className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">安全設定</h2>
            <dl className="mt-4 divide-y divide-gray-100">
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-gray-600">自動リマインド</dt><dd className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-700">OFF</dd></div>
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-gray-600">支払申告だけでの会員化</dt><dd className="text-sm font-semibold text-green-700">禁止</dd></div>
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-gray-600">決済確認前のpurchase作成</dt><dd className="text-sm font-semibold text-green-700">禁止</dd></div>
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-gray-600">データ不一致</dt><dd className={`text-sm font-bold ${displayedSummary.mismatchCount > 0 ? 'text-red-700' : 'text-gray-700'}`}>{displayedSummary.mismatchCount}件</dd></div>
            </dl>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">監査ログ</h2>
            <p className="mt-3 text-sm leading-6 text-gray-600">誰が決済確認・承認・LINE送信・ステータス変更を行ったかは、追記式ログで記録します。</p>
            <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-500">
              監査ログ一覧は専用API接続後にここへ表示されます。現在の画面では申込進捗の閲覧のみ可能です。
            </div>
          </div>
        </section>
      )}
      {editingApplicant && <ContactControlDialog applicant={editingApplicant} saving={savingControl} error={controlError} onClose={() => { if (!savingControl) setEditingApplicant(null) }} onSave={(value) => void saveContactControl(value)} />}
    </div>
  )
}
