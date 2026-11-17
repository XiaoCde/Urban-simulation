# -*-coding:utf-8 -*-
# python3.9
# 计算local:non-local
# 修改inputParams

"""
# @File       : 4_PopRatio.py
# @software   : PyCharm  
# @Time       ：2024/6/14 21:44
# @Author     ：Wei Lyu
"""

import pandas as pd
import os

from fractions import Fraction


def approximate_fraction(decimal):
    # Generate all possible fractions within the given constraints
    possible_fractions = [Fraction(n, d) for d in range(1, 10) for n in range(1, 10)]

    # Find the fraction that is closest to the input decimal
    closest_fraction = min(possible_fractions, key=lambda x: abs(x - decimal))

    return closest_fraction

if __name__ == '__main__':
    path = 'D:/LW/ABM/Data'

    outputPath = 'D:/LW/ABM/OutputData'
    dir_path = outputPath + '/cities_21'

    inputParam = pd.read_csv(outputPath + '/Result/shenzhen/inputParam.csv', header=None)   # 靶子格式

    df1 = pd.read_excel(path + '/' + '21个城市中国统计年鉴数据.xlsx', header=0)
    df2 = pd.read_csv(dir_path + '/' + 'cities_row_col.csv', header=0)

    df = pd.merge(df1, df2, how='left', left_on='城市', right_on='city_name')
    del df1, df2

    city_names = df['城市'].unique().tolist()

    k = 0
    for name in city_names:
        # 拼接完整路径
        folder_path = os.path.join(outputPath + '/Result/cities_92', name)
        os.mkdir(folder_path)
        os.mkdir(folder_path + '/pic')
        for i in range(3):
            os.mkdir(folder_path + '/pic/sigma=' + str(i))
        result = approximate_fraction(df.iloc[k, 6])
        pop_ratio = result.numerator * 10 + result.denominator
        rows = df.iloc[k, 9]
        cols = df.iloc[k, 10]
        inputParam.iloc[2, 1] = pop_ratio
        inputParam.iloc[3, 1] = rows
        inputParam.iloc[4, 1] = cols
        inputParam.to_csv(folder_path + '/inputParam.csv', index=False, header=False)
        k += 1
        print(name)


