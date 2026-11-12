import assert from "node:assert/strict";
import { formatDisplayAddress, normalizeStreetAndHouse } from "../src/utils/addressFormatter.js";

export function assertAddressFormatter(): void {
  // Minsk formatting
  assert.equal(
    formatDisplayAddress("Яна Чечота ул, 28, Минск", "Минск"),
    "Минск, ул. Яна Чечота, 28"
  );
  assert.equal(
    formatDisplayAddress("Минск Чечота ул. 28", "Минск"),
    "Минск, ул. Чечота, 28"
  );
  assert.equal(
    formatDisplayAddress("Беларусь, Минск, улица Яна Чечота, 28", "Минск"),
    "Минск, ул. Яна Чечота, 28"
  );
  assert.equal(
    formatDisplayAddress("Мира пр, 8, Минск", "Минск"),
    "Минск, просп. Мира, 8"
  );
  assert.equal(
    formatDisplayAddress("Минск Мира просп. 8", "Минск"),
    "Минск, просп. Мира, 8"
  );
  assert.equal(
    formatDisplayAddress("Минск Победителей просп. 135 А", "Минск"),
    "Минск, просп. Победителей, 135А"
  );
  assert.equal(
    formatDisplayAddress("площадь Старый Аэропорт, 2, Минск", "Минск"),
    "Минск, пл. Старый Аэропорт, 2"
  );
  assert.equal(
    formatDisplayAddress("Минск Старый Аэропорт пл. 2", "Минск"),
    "Минск, пл. Старый Аэропорт, 2"
  );
  assert.equal(
    formatDisplayAddress("г. Минск, Ваньковича ул., д. 26", "Минск"),
    "Минск, ул. Ваньковича, 26"
  );
  assert.equal(
    formatDisplayAddress("Минск Рафиева ул. 88 А", "Минск"),
    "Минск, ул. Рафиева, 88А"
  );
  assert.equal(
    formatDisplayAddress("Минск Козлова пер. 20 б", "Минск"),
    "Минск, пер. Козлова, 20б"
  );
  assert.equal(
    formatDisplayAddress("Минск Логойский тракт 6", "Минск"),
    "Минск, Логойский тракт, 6"
  );
  assert.equal(
    formatDisplayAddress("Шевченко бул, 5, Минск", "Минск"),
    "Минск, бул. Шевченко, 5"
  );
  assert.equal(
    formatDisplayAddress("Minsk, вуліца Жарэса Алфёрава", "Минск"),
    "Минск, ул. Жарэса Алфёрава"
  );
  assert.equal(
    formatDisplayAddress("Минск Ковалева ул.", "Минск"),
    "Минск, ул. Ковалева"
  );
  assert.equal(
    formatDisplayAddress(
      "здание Дом Танго, квартал Мировых Танцев, экспериментальный многофункциональный комплекс Минск-Мир, Минск",
      "Минск"
    ),
    "Минск, здание Дом Танго, квартал Мировых Танцев, экспериментальный многофункциональный комплекс Минск-Мир"
  );

  // Outside Minsk formatting
  assert.equal(
    formatDisplayAddress("Самохваловичский сельский Совет, Самохваловичи, улица Ковалёва, 8", "Самохваловичи"),
    "Минская область, Самохваловичи, ул. Ковалёва, 8"
  );
  assert.equal(
    formatDisplayAddress("Самохваловичи Ковалева ул. 8", "Самохваловичи"),
    "Минская область, Самохваловичи, ул. Ковалева, 8"
  );
  assert.equal(
    formatDisplayAddress(
      "Беларусь, Минская область, Минский район, Самохваловичский сельский Совет, Самохваловичи, Ковалева ул. 10",
      "Самохваловичи"
    ),
    "Минская область, Самохваловичи, ул. Ковалева, 10"
  );
  assert.equal(
    formatDisplayAddress("Заславль, ул. Советская, 15", "Заславль"),
    "Минская область, Заславль, ул. Советская, 15"
  );
  assert.equal(
    formatDisplayAddress("Фаниполь, Комсомольская ул., 12", "Фаниполь"),
    "Минская область, Фаниполь, ул. Комсомольская, 12"
  );
  assert.equal(
    formatDisplayAddress("Колодищи Хвойная Аллея ул. 6", "Колодищи"),
    "Минская область, Колодищи, ул. Хвойная Аллея, 6"
  );
  assert.equal(
    formatDisplayAddress("Боровлянский сельский Совет, Копище, улица Лопатина, 7", "Копище"),
    "Минская область, Копище, ул. Лопатина, 7"
  );
  assert.equal(
    formatDisplayAddress("Беларусь, Волковичи, Поселковая ул., 2 А", "Волковичи"),
    "Минская область, Волковичи, ул. Поселковая, 2А"
  );
  assert.equal(
    formatDisplayAddress("Минская область, Минский район, Тарасово, Проектируемая улица, 9", "Тарасово"),
    "Минская область, Тарасово, ул. Проектируемая, 9"
  );
  assert.equal(
    formatDisplayAddress("Беларусь, Карповичи, Новая ул.", "Карповичи"),
    "Минская область, Карповичи, ул. Новая"
  );
  assert.equal(
    formatDisplayAddress("Луговослободской сельский Совет, Заямочное", "Заямочное"),
    "Минская область, Заямочное"
  );
  assert.equal(
    formatDisplayAddress("Беларусь, Минская обл., Минский район, Юхновка, Вишнёвая ул., 16", "Минская обл."),
    "Минская область, Юхновка, ул. Вишнёвая, 16"
  );
  assert.equal(
    formatDisplayAddress("Сеница, Зеленая ул., 1", "Сеница"),
    "Минская область, Сеница, ул. Зеленая, 1"
  );
  assert.equal(
    formatDisplayAddress("Боровляны, ул. 40 лет Победы, 34", "Боровляны"),
    "Минская область, Боровляны, ул. 40 лет Победы, 34"
  );

  // Object input and fallback handling
  assert.equal(
    formatDisplayAddress({
      address: "Мира пр, 8, Минск",
      locality: "Минск"
    }),
    "Минск, просп. Мира, 8"
  );
  assert.equal(
    formatDisplayAddress({
      address: null,
      locality: null,
      title: "2-комнатная квартира"
    }),
    "2-комнатная квартира"
  );
  assert.equal(
    formatDisplayAddress(null, null, "3-комнатная новостройка"),
    "3-комнатная новостройка"
  );
}
