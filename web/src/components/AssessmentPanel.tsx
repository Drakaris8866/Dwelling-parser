import { ChevronDown } from "lucide-react";
import type { CatalogAssessment, CatalogDetail } from "../../../src/contracts/catalog.js";
import { confidenceLabels, repairLabels } from "../../../src/contracts/labels.js";
import { Rating } from "./ListingCard.js";
import { RenovationBudget } from "./RepairPanel.js";
import { ComparableCard } from "./ComparableCard.js";
import "../listingDetail.css";

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const usdPerMeter = (value: number): string => `$${number.format(value)}/м²`;

function PriceBreakdown({ assessment, reason }: { assessment: CatalogAssessment; reason: string | undefined }) {
  const a = assessment, e = a.priceEvidence;
  return <div className="assessment-breakdown" aria-label="Расчёт выгодности">
    <h4>Рыночная выгодность</h4>
    {e?.repair && <p className="muted small">Ремонт: {repairLabels[e.repair]} · {e.repairSource === "photo" ? "подтверждено по фото" : "по объявлению"}</p>}
    {e && <dl className="price-evidence"><div><dt>Цена в расчёте</dt><dd>{usdPerMeter(e.priceSqm)}</dd></div><div><dt>Медиана аналогов</dt><dd>{a.medianPriceSqm === null ? "Нет оценки" : usdPerMeter(a.medianPriceSqm)}</dd></div><div><dt>Аналоги</dt><dd>{a.comparableCount}{a.radiusMeters !== null ? ` · ${a.radiusMeters} м` : ""}</dd></div></dl>}
    {!e && a.medianPriceSqm !== null && <p>Медиана: <strong>{usdPerMeter(a.medianPriceSqm)}</strong> · {a.comparableCount} аналогов · {a.radiusMeters} м</p>}
    {a.valueScore === null && <p className="muted small">{reason ?? "Недостаточно сопоставимых данных."}</p>}
    {e && a.medianPriceSqm !== null && a.discountPct !== null && e.rawScore !== null && a.valueScore !== null && <div className="assessment-equations">
      <p>Дисконт: <strong>({number.format(a.medianPriceSqm)} − {number.format(e.priceSqm)}) / {number.format(a.medianPriceSqm)} × 100 = {number.format(a.discountPct)}%</strong></p>
      {e.curveScale && e.evidenceWeight != null ? <>
        <p>Балл: <strong>{number.format(e.base)} + {number.format(e.base)} × {number.format(a.discountPct)} / ({e.curveScale} + |{number.format(a.discountPct)}|) × {number.format(e.evidenceWeight * 100)}% ≈ {number.format(a.valueScore)}/100</strong></p>
        <p className="muted small">Вес доказательств: {number.format(e.evidenceWeight * 100)}%. Малое число аналогов, неизвестные параметры и разброс цен приближают балл к нейтральным 50.</p>
      </> : <p>Балл по прежней шкале: <strong>{number.format(a.valueScore)}/100</strong></p>}
    </div>}
    {a.priceRangeLow !== null && a.priceRangeHigh !== null && <p className="muted small">Средние 50% предложений: {usdPerMeter(a.priceRangeLow)}–{usdPerMeter(a.priceRangeHigh)}.</p>}
    {a.confidence !== "none" && <p className="muted small">{confidenceLabels[a.confidence]}. {e?.confidenceEvidence}</p>}
    {e && <details className="assessment-disclosure"><summary><ChevronDown size={15} />Как отобраны аналоги</summary><ul className="reason-list">{e.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul></details>}
  </div>;
}

function ComfortBreakdown({ assessment }: { assessment: CatalogAssessment }) {
  const a = assessment;
  const pendingSettings = a.comfortScore === null && a.coverage === 0 && a.components.some((group) => group.score !== null && group.weight > 0);
  return <div className="assessment-breakdown" aria-label="Расчёт удобства">
    <h4>Критерии удобства</h4>
    {pendingSettings ? <p className="muted small">Ожидает пересчёта после изменения настроек.</p> : <>
      <p className="muted small">Заполненность: <strong>{number.format(a.coverage)}%</strong>{a.coverage < 70 ? " · ниже 70%, оценка предварительная" : ""}. Балл группы — среднее известных критериев с учётом их весов. Неизвестные критерии не добавляют баллов.</p>
      {a.components.map((group) => {
        const points = group.points ?? (group.score ?? 0) * group.coverage / 100 * group.weight / 100;
        return <details className="assessment-disclosure" key={group.code}>
          <summary><ChevronDown size={15} /><span>{group.label}</span><strong>{group.weight === 0 ? "Не учитывается" : `${number.format(points)} / ${group.weight}`}</strong></summary>
          <p className="group-equation">{group.score === null ? "Нет известных критериев" : `${number.format(group.score)}/100 × ${group.coverage}% заполненности × ${group.weight}% веса = ${number.format(points)} балла`}</p>
          {group.criteria ? <ul className="scoring-criteria">{group.criteria.map((criterion) => <li key={criterion.code}>
            <div className="criterion-result"><div><strong>{criterion.label}</strong><span>{criterion.observed ?? "Неизвестно"}</span></div><div><strong>{criterion.score === null ? "Нет балла" : `${number.format(criterion.score)}/100`}</strong><span>{criterion.weight}% группы</span></div></div>
            <p className="muted small">{criterion.rule}</p>
          </li>)}</ul> : <p className="muted small">Значения отдельных критериев появятся после пересчёта.</p>}
        </details>;
      })}
      {a.comfortScore !== null && <p className="comfort-total">Сумма вкладов: <strong>{number.format(a.comfortScore)}/100</strong></p>}
    </>}
  </div>;
}

export function AssessmentPanel({ detail, onOpen }: { detail: CatalogDetail; onOpen: (id: string) => void }) {
  const { item } = detail;
  const a = item.assessment;
  const scenario = a?.renovationScenario;
  const current = scenario && scenario.budgetUsd === item.renovationBudgetUsd && scenario.purchaseUsd === item.priceUsd ? scenario : null;
  return <section className="detail-section assessment-panel"><h3>Оценка квартиры</h3>
    <div className="detail-ratings"><Rating label="Выгодность" value={a?.valueScore ?? null} status={item.processing?.value} precise /><Rating label="Удобство" value={a?.comfortScore ?? null} status={item.processing?.comfort} provisional={!!a && a.coverage < 70} precise /></div>
    {a ? <>
      <PriceBreakdown assessment={a} reason={item.processing?.value.message} />
      <ComfortBreakdown assessment={a} />
      {(item.routes?.target?.calculatedAt ?? "") > a.calculatedAt && <p className="muted small">Маршрут обновлён после оценки. До пересчёта показаны прежние баллы.</p>}
      <p className="muted small">Расчёт: {new Date(a.calculatedAt).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })} · {a.version}</p>
    </> : <p className="muted">{item.processing?.value.message ?? "Оценка ожидает расчёта."}</p>}
    <div className="assessment-breakdown"><h4>Выгодность с учётом ремонта</h4>
      <RenovationBudget detail={detail} />
      {item.renovationBudgetUsd != null && !current && <p className="muted small">Сценарий ожидает пересчёта.</p>}
      {current && <>
        <dl className="price-evidence"><div><dt>Покупка</dt><dd>${number.format(current.purchaseUsd)}</dd></div><div><dt>Ремонт</dt><dd>${number.format(current.budgetUsd)}</dd></div><div><dt>Полная стоимость</dt><dd>${number.format(current.totalUsd)}</dd></div></dl>
        <p className="muted small">{usdPerMeter(current.priceSqm)} после ремонта. Аналоги: готовые квартиры с хорошим ремонтом.</p>
        {current.valueScore === null ? <p className="muted small">Недостаточно аналогов для балла.</p> : <p>Медиана {usdPerMeter(current.medianPriceSqm!)} · дисконт {number.format(current.discountPct!)}% · <strong>{number.format(current.valueScore)}/100</strong></p>}
        {!!current.comparables.length && <details className="assessment-disclosure"><summary><ChevronDown size={15} />Аналоги после ремонта: {current.comparables.length} · {current.radiusMeters} м</summary><div className="comparables-scroll" style={{ marginTop: "10px" }}>{current.comparables.map((comp) => <ComparableCard key={comp.propertyId} item={comp} onOpen={onOpen} />)}</div></details>}
      </>}
    </div>
  </section>;
}
