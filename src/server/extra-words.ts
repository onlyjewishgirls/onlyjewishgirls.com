/**
 * Words the English dictionary misses but people put in passwords anyway:
 * Hebrew/Yiddish transliterations, common Jewish names, and password clichés.
 * Anything shorter than 4 letters is ignored by the dictionary rule.
 */
export const EXTRA_WORDS = [
  // Hebrew & Yiddish
  "shalom", "shabbat", "shabbos", "torah", "talmud", "mishna", "mishnah", "hashem", "elokim",
  "elohim", "adonai", "mazel", "mazal", "mazeltov", "kosher", "mitzvah", "mitzva", "mitzvot",
  "mitzvos", "tzedakah", "tzedaka", "chesed", "emunah", "emuna", "simcha", "simchah", "bracha",
  "brachah", "beracha", "yisrael", "israel", "jerusalem", "yerushalayim", "zion", "tzion",
  "menorah", "chanukah", "chanuka", "hanukkah", "hanukah", "pesach", "purim", "sukkot", "sukkos",
  "shavuot", "shavuos", "kippur", "yomtov", "yomtif", "yontif", "yontiff", "hashana", "hashanah",
  "shofar", "mezuzah", "mezuza", "tefillin", "tallit", "tallis", "kippah", "kipa", "yarmulke",
  "shul", "rabbi", "rebbe", "rebbetzin", "yeshiva", "kallah", "kalla", "chatan", "chosson",
  "shidduch", "shidduchim", "shadchan", "mensch", "chutzpah", "chutzpa", "schlep", "shlep",
  "kvetch", "bubbe", "bubby", "zayde", "zaidy", "challah", "latke", "latkes", "kugel", "cholent",
  "matzah", "matzo", "matza", "bagel", "todah", "ahava", "ahavah", "neshama", "neshamah",
  "tehillim", "daven", "davening", "kiddush", "havdalah", "havdala", "mikvah", "mikva", "tznius",
  "tzniut", "frum", "haredi", "chassid", "chasid", "hasidic", "chassidish", "chabad", "lubavitch",
  "sephardi", "sefardi", "ashkenazi", "mizrahi", "aliyah", "kibbutz", "sabra", "moshiach",
  "mashiach", "geula", "geulah", "shekel", "hebrew", "yiddish", "ivrit", "jewish", "judaism",
  "jewess", "onlyjewishgirls",
  // Names
  "avraham", "abraham", "yitzchak", "yitzhak", "isaac", "yaakov", "yakov", "jacob", "moshe",
  "moses", "aharon", "aaron", "david", "dovid", "shlomo", "solomon", "yosef", "joseph", "sarah",
  "sara", "rivka", "rivkah", "rebecca", "rachel", "rochel", "leah", "miriam", "esther", "chana",
  "chanah", "hannah", "devorah", "deborah", "ruth", "shoshana", "tova", "tovah", "chaya", "malka",
  "yehuda", "judah", "levi", "binyamin", "benjamin", "menachem", "mendel", "shmuel", "samuel",
  "eliyahu", "elijah", "chaim", "batsheva", "naomi", "avigail", "abigail", "ayala", "tamar",
  "yael", "michal", "dina", "dinah", "adina", "aviva", "shira", "tzipora", "tzippy", "bracha",
  "elisheva", "yehudis", "yehudit", "golda", "gittel", "raizel", "rivky", "chani", "devora",
  // Password clichés
  "passwd", "password", "letmein", "iloveyou", "trustno", "qwerty", "azerty", "admin", "login",
  "welcome", "secret", "master", "dragon", "monkey", "shadow", "sunshine", "princess", "baseball",
  "football", "superman", "batman", "starwars", "whatever", "freedom", "hello", "abcd",
];
