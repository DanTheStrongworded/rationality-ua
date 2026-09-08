# Раціональність: від Алгоритмів до Якорування
![Poster](./assets/Poster.png)
<p align="center">
    <a href="https://plvn.app/uk/rationality">Читати онлайн</a> | <a href="./assets/">Завантажити у PDF</a>
</p>

\
Український переклад книги Елієзера Юдковскі [Rationality: from AI to Zombies](https://www.readthesequences.com)

Переклав: [Данило Жирко](https://t.me/misterlinguist) \
Задизайнив та закодив: [Денис Лук'яненко](https://t.me/denlukia)

## Як публікувати приватні зміни

Приватна книга лежить у `books/private/` — це звичайна папка, можна редагувати файли як завжди.

- Після клонування: `git clone --recurse-submodules https://github.com/DanTheStrongworded/rationality-ua-public.git` (або `git submodule update --init` і `bash code/scripts/install-hooks.sh` у вже склонований)
- Збереження: `./publish.sh що зробив` — спочатку відправляє приватну книгу, потім усе інше
- Після перемикання гілки: `git submodule update`
- Не пуш вручну: якщо `git push` відхилено — запусти `./publish.sh`
