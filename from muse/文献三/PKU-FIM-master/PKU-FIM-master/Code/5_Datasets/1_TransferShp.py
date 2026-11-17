# -*-coding:utf-8 -*-
# python 3.9
# 转移每个城市的shapefile

"""
# @File       : 1_TransferShp.py
# @software   : PyCharm  
# @Time       ：2025/7/22 23:00
# @Author     ：Wei Lyu
"""

import pandas as pd
import shutil

if __name__ == '__main__':
    path = 'D:/LW/ABM'

    suffix = ['.cpg', '.dbf', '.prj', '.sbn', '.sbx', '.shp.xml', '.shx']
    relation = pd.read_csv(path + r'\OutputData\cities_21\cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    for i in range(len(cities_cn)):
        city_en = cities_en[i][:-3].capitalize()
        city_cn = cities_cn[i]
        if city_en == 'Haerbin':
            city_en = 'Harbin'
        if city_en == 'Xian':
            city_en = 'Xi\'an'
        for i in range(len(suffix)):
            from_path = path + r'\OutputData\cities_21' + '\\' + city_cn + '\\' + city_cn + '_grid' + suffix[i]
            to_path = path + r'\Datasets\SHP' + '\\' + city_en + suffix[i]
            shutil.copyfile(from_path, to_path)
